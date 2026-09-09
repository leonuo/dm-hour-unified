from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_R = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
ET.register_namespace("", NS)

CELL_REF = re.compile(r"([A-Z]+)([0-9]+)")


def _col_index(letters: str) -> int:
    value = 0
    for char in letters:
        value = value * 26 + (ord(char) - 64)
    return value - 1


def _col_letters(index: int) -> str:
    index += 1
    letters = []
    while index:
        index, remainder = divmod(index - 1, 26)
        letters.append(chr(65 + remainder))
    return "".join(reversed(letters))


def _cell_text(cell: ET.Element, strings: list[str]) -> str:
    cell_type = cell.get("t")
    value = cell.find(f"{{{NS}}}v")
    if cell_type == "s":
        if value is None or value.text is None:
            return ""
        return strings[int(value.text)]
    if cell_type == "inlineStr":
        texts = [node.text or "" for node in cell.iter(f"{{{NS}}}t")]
        return "".join(texts)
    if value is not None and value.text is not None:
        return value.text
    return ""


def read_xlsx_rows(path: str | Path) -> list[list[str]]:
    with ZipFile(path) as archive:
        names = set(archive.namelist())
        strings: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall(f"{{{NS}}}si"):
                texts = [node.text or "" for node in item.iter(f"{{{NS}}}t")]
                strings.append("".join(texts))
        sheet_path = "xl/worksheets/sheet1.xml"
        if "xl/workbook.xml" in names and "xl/_rels/workbook.xml.rels" in names:
            rels_root = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
            rels = {
                rel.get("Id"): rel.get("Target")
                for rel in rels_root
            }
            workbook = ET.fromstring(archive.read("xl/workbook.xml"))
            first = workbook.find(f".//{{{NS}}}sheet")
            if first is not None:
                target = rels.get(first.get(f"{{{NS_R}}}id") or "")
                if target:
                    sheet_path = "xl/" + target.lstrip("/") if not target.startswith("xl/") else target
                    if sheet_path.startswith("/"):
                        sheet_path = sheet_path[1:]
        if sheet_path not in names:
            raise ValueError("XLSX workbook has no worksheet")
        sheet = ET.fromstring(archive.read(sheet_path))

    rows: list[list[str]] = []
    for row in sheet.findall(f".//{{{NS}}}sheetData/{{{NS}}}row"):
        cells: dict[int, str] = {}
        max_index = -1
        for cell in row.findall(f"{{{NS}}}c"):
            ref = cell.get("r") or ""
            match = CELL_REF.fullmatch(ref)
            index = _col_index(match.group(1)) if match else max_index + 1
            cells[index] = _cell_text(cell, strings)
            max_index = max(max_index, index)
        if max_index < 0:
            rows.append([])
            continue
        rows.append([cells.get(index, "") for index in range(max_index + 1)])
    return rows


def read_xlsx_dicts(path: str | Path) -> list[dict[str, str]]:
    rows = read_xlsx_rows(path)
    if not rows:
        raise ValueError("XLSX sheet is empty")
    headers = [str(value).strip() or f"column_{index}" for index, value in enumerate(rows[0])]
    records = []
    for row in rows[1:]:
        if not any(str(value).strip() for value in row):
            continue
        record = {}
        for index, header in enumerate(headers):
            record[header] = row[index] if index < len(row) else ""
        records.append(record)
    return records


def write_xlsx(path: str | Path, rows: list[list[str]]) -> None:
    strings: list[str] = []
    index_by_value: dict[str, int] = {}

    def intern(value: str) -> int:
        if value not in index_by_value:
            index_by_value[value] = len(strings)
            strings.append(value)
        return index_by_value[value]

    sheet_rows = []
    for row_number, row in enumerate(rows, start=1):
        cells = []
        for column, raw in enumerate(row):
            value = "" if raw is None else str(raw)
            ref = f"{_col_letters(column)}{row_number}"
            cells.append(
                f'<c r="{ref}" t="s"><v>{intern(value)}</v></c>'
            )
        sheet_rows.append(f'<row r="{row_number}">{"".join(cells)}</row>')

    shared = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<sst xmlns="{NS}" count="{len(strings)}" uniqueCount="{len(strings)}">',
    ]
    for value in strings:
        escaped = (
            value.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )
        shared.append(f'<si><t xml:space="preserve">{escaped}</t></si>')
    shared.append("</sst>")

    workbook = f"""<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="{NS}" xmlns:r="{NS_R}">
  <sheets>
    <sheet name="Contacts" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>
"""
    rels = f"""<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="{NS_PKG_R}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>
"""
    root_rels = f"""<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="{NS_PKG_R}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
"""
    content_types = f"""<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="{NS_CT}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>
"""
    sheet = (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<worksheet xmlns="{NS}"><sheetData>{"".join(sheet_rows)}</sheetData></worksheet>'
    )
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", rels)
        archive.writestr("xl/sharedStrings.xml", "\n".join(shared))
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
