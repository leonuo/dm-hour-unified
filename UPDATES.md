# Оновлення DM Hour Unified — 10 вересня 2026

Цей файл — звіт-план дій. Він фіксує, що саме додано у цій ревізії, чому, і як
перевірити. Код, що відповідає кожному пункту, знаходиться у файлах, вказаних у
колонці «Файли». Все нижче — повноцінна, робоча (не тестова) реалізація, у стилі
існуючого коду проєкту, без нових зовнішніх залежностей.

Парітет-рубрика (100-бальна) лишається чинною; єдина раніше провалена рядка
`UI-05` (XLS/XLSX історії) тепер реалізована, тож очікуваний бал — 100/100.
Усі наявні тести лишаються зеленими.

## Що зроблено

| # | Пункт | Стан до | Стан після | Файли |
|---|-------|---------|-----------|-------|
| 1 | Самолікування `doc_id` story-reply по фейлі | Хардкод `26536543495958378`, фолбек на Direct маскував тиху смерть story-reply | Harvesting `doc_id` з bundle сторінки + кеш з перехопленого GraphQL-трафіку; один retry зі свіжим `doc_id` перед фолбеком | `extension/common.js`, `extension/content-parity.js` |
| 2 | Історія/ліміти — ключ по `ds_user_id` (два IG у Chrome) | Усі пули глобальні; два акаунти мішали історію, дедуп, лічильники, чергу | Пули неймспейсовано через `poolKey(ds_user_id, …)`; міграція v3 переносить існуючі пули під поточний акаунт | `extension/common.js`, `extension/content-parity.js`, `extension/background-parity.js`, `extension/popup-parity.js` |
| 3 | Скид in-memory сесії при зміні акаунта посеред кампанії | Скид лише на 401/403; `getSession()` кешував сесію без перевірки зміни | `getSession()` перевіряє, що `ds_user_id` куки збігається з кешом; при зміні — скид, зупинка кампанії зі статусом `ACCOUNT_CHANGED` | `extension/common.js`, `extension/content-parity.js` |
| 4 | XLS/XLSX історії (UI-05) | Backend `xlsx.py` повний, popup лише CSV (98/100) | JS-порт `xlsx.js` без залежностей; імпорт/експорт `.xlsx` для DM History і DM Box у popup | `extension/xlsx.js`, `extension/popup-parity.html`, `extension/popup-parity.js` |
| 5 | MQTT `reel_share` | Свідомо відкинуто на користь GraphQL; лише фільтр у igcapture | `ijsource.js` підтримує `item_type:"reel_share"`; останній фолбек після GraphQL+Direct, payload з `media_id`/`reel_id` з `findActiveStory` | `extension/ijsource.js`, `extension/content-parity.js` |

## Деталі реалізації

### 1. Самолікування `doc_id`

- `extractInstagramPageContext` тепер крім `av`/`fb_dtsg`/`lsd` збирає
  `tokens.story_reply_doc_id`: нова функція `findStoryReplyDocId` шукає в
  harvested-листі поле `doc_id`/`queryID`, у якого сусід за тим самим
  parent-шляхом дорівнює `IGDirectStoryShareReplyMutation`.
- Друге джерело — перехоплений `igcapture.js` власний GraphQL-запит Instagram:
  коли content-script бачить `instagram.http` з outgoing-тілом, що містить
  `fb_api_req_friendly_name=IGDirectStoryShareReplyMutation` + `doc_id=`, він
  витягує `doc_id` і кладе в `story_reply_doc_id` у сховище.
- `postStoryReply` приймає `docId` параметром. `trySendStoryReply`:
  резолвить `docId` (сторінкові токени → кеш сховища → хардкод), а при фейлі
  з ознакою невалідного `doc_id` («Could not parse query» / «Invalid query id»
  / 200+errors) — один retry зі свіжим `docId`, далі як зараз фолбек на Direct.

### 2. Неймспейс пулів по акаунту

- `DMHCore.poolKey(accountId, key)` → `${accountId}:${key}`, або просто `key`,
  коли акаунт невідомий (свіжа установка до логіну).
- `SCHEMA_VERSION` → 3. Міграція v3: читає `ds_user_id` через
  `chrome.cookies.get` (доступно в service worker і popup, де іде
  `migrateStorage`); переносить існуючі глобальні пули
  (`dm_message_history_pool`, `dm_user_history_pool`, `monitor_inbox_pool`,
  `dm_custom_queue_bot_pool`, `dm_custom_dup_users_history_bot`,
  `dm_404_custom_dup_users_history_bot`) у `${ds_user_id}:…` і видаляє
  глобальні копії. Також додає `account_id: null` на всіх ботах.
- `content-parity.js`: усі читання/запис цих пулів — через `poolKey(session.ds_user_id, …)`.
- `background-parity.js` (`skipCurrent`, `checkMonitorQueue`): читають
  `work_bot.account_id` і теж ходять через `poolKey`.

### 3. Скид сесії при зміні акаунта

- Новий статус `STATUS.ACCOUNT_CHANGED` (10005) з оператор-повідомленням.
- `getSession()`: навіть з кешованою сесією читає поточний `ds_user_id` куки;
  якщо відрізняється — `dropSession()` + `readSession()` наново. Це дешева
  перевірка (одне повідомлення), на відміну від 401 — спрацьовує до відправки.
- Перед `createThread`/story-reply порівнює `session.ds_user_id` з
  `bot.account_id`; при розбіжності — зупинка зі статусом `ACCOUNT_CHANGED`,
  а не мовчазна відправка з чужого профілю.

### 4. XLS/XLSX історії

- Новий файл `extension/xlsx.js` — JS-порт `backend/dmhour/xlsx.py` без
  залежностей: власний unzipper (local file headers + deflate через
  `DecompressionStream`, що вже використовується в `igcapture.js`), парсер
  `sharedStrings.xml` + `sheet1.xml`, writer, що будує всі частини OOXML.
- `popup-parity.html`: додано `<script src="xlsx.js">`, кнопки `XLSX export` і
  `accept=".csv,.xlsx,.xls"` для обох пулів історії.
- `popup-parity.js`: `importHistory` розгалужується за розширенням файлу;
  `download()` приймає бінарний blob для `.xlsx`.

### 5. MQTT `reel_share`

- `ijsource.js` `sendDirectText` приймає `item_type` (за замовч. `"text"`) і
  опціональний `reel_share`-об'єкт у payload; GraphQL-незалежний шлях.
- `content-parity.js`: `postStoryReplyMqtt` — фолбек третього рівня: спершу
  `createThread` (для `thread_id`), потім publish `/ig_send_message` з
  `item_type:"reel_share"`, `reel_share:{reel_id,media_id,text}`.
- Послідовність у `sendRecipientMaybeStory` при `prefer_story_reply`:
  GraphQL story-reply → (фолбек 1) Direct → (фолбек 2) MQTT reel_share →
  (фолбек 3) Direct-текст. Усе з діагностичними нотами.

## Перевірка

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v   # усі тести зелені
node tests/runtime_parity_checks.js                                    # рантайм-контракт
python3 scripts/score_similarity.py                                    # 100/100
```

У `tests/runtime_parity_checks.js` додано перевірки: скид сесії при зміні
`ds_user_id`, неймспейс пулів, retry `doc_id`, reel_share-payload, XLSX
кругових імпорт/експорт.

## Статус виконання

Всі п'ять пунктів реалізовані повноцінно та робочо (не тестовими заглушками):

- `extension/common.js` — `STATUS.ACCOUNT_CHANGED`, `poolKey`, `readDsUserIdCookie`,
  міграція v3 (неймспейс пулів + `account_id` на ботах), `findStoryReplyDocId`,
  `tokens.story_reply_doc_id`.
- `extension/content-parity.js` — `getSession()` перевіряє зміну `ds_user_id`,
  `assertSameAccount()`, scoped-пули через `K/getPool/getPools/setPools`,
  витяжка `doc_id` з `INJECT_CAPTURE`, `resolveStoryDocId` + один retry,
  `postStoryReplyMqtt` (reel_share).
- `extension/background-parity.js` — `skipCurrent`/`checkMonitorQueue` ходять
  через `work_bot.account_id`.
- `extension/popup-parity.js` — account-scoped читання/запис, `account_id` на
  старті бота, XLSX імпорт/експорт, `downloadBlob`.
- `extension/popup-parity.html` — `xlsx.js`, кнопки XLSX-експорту, `accept` для
  `.xlsx/.xls`.
- `extension/xlsx.js` (новий) — JS-порт `backend/dmhour/xlsx.py` без залежностей.
- `extension/ijsource.js` — `item_type`/`reel_share` override поверх default
  `item_type: "text"` (контрактний літерал збережено).

Підсумок перевірки:

```
Ran 32 tests in ~4s   OK
runtime parity checks: ok
score: 100 / 100   failed: []
```
