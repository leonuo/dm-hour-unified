from __future__ import annotations

import random
import re
from collections.abc import Mapping


VARIABLE_RE = re.compile(r"{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}")


def render_variables(template: str, values: Mapping[str, object]) -> str:
    """Replace known {{variables}} and leave unknown variables untouched."""

    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        return str(values[key]) if key in values and values[key] is not None else match.group(0)

    return VARIABLE_RE.sub(replace, template)


def render_spintax(text: str, rng: random.Random | None = None) -> str:
    """Render nested {one|two} expressions from the inside out."""

    rng = rng or random.Random()
    while True:
        close = text.find("}")
        if close < 0:
            return text
        open_at = text.rfind("{", 0, close)
        if open_at < 0:
            return text
        body = text[open_at + 1 : close]
        choices = body.split("|")
        if len(choices) == 1:
            text = text[:open_at] + "{" + body + "}" + text[close + 1 :]
            next_close = text.find("}", close + 1)
            if next_close < 0:
                return text
            # Avoid looping forever on ordinary braces.
            return text
        text = text[:open_at] + rng.choice(choices) + text[close + 1 :]


def render_message(
    templates: list[str], values: Mapping[str, object], rng: random.Random | None = None
) -> str:
    if not templates:
        raise ValueError("At least one message template is required")
    rng = rng or random.Random()
    template = rng.choice(templates)
    with_variables = render_variables(template, values)
    return render_spintax(with_variables, rng)

