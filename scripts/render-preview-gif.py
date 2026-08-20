#!/usr/bin/env python3

import json
import re
import sys
import unicodedata
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ANSI = re.compile(r"\x1b\[([0-9;]*)m|\x1b\[2K")
GROUND = (8, 11, 15)
INK = (231, 237, 242)


def cell_span(character: str) -> int:
    if unicodedata.combining(character):
        return 0
    return 2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1


def draw_ansi_line(
    draw: ImageDraw.ImageDraw,
    line: str,
    origin: tuple[int, int],
    font: ImageFont.FreeTypeFont,
    cell_width: int,
) -> None:
    x, y = origin
    foreground = INK
    bold = False
    cursor = 0
    for match in ANSI.finditer(line):
        segment = line[cursor:match.start()]
        for character in segment:
            draw.text((x, y), character, font=font, fill=foreground)
            if bold and character.strip():
                draw.text((x + 1, y), character, font=font, fill=foreground)
            x += cell_width * cell_span(character)
        code = match.group(1)
        if code is not None:
            values = [int(value) for value in code.split(";") if value]
            if not values or values == [0]:
                foreground = INK
                bold = False
            elif values == [1]:
                bold = True
            elif len(values) == 5 and values[:2] == [38, 2]:
                foreground = tuple(values[2:5])
        cursor = match.end()
    for character in line[cursor:]:
        draw.text((x, y), character, font=font, fill=foreground)
        if bold and character.strip():
            draw.text((x + 1, y), character, font=font, fill=foreground)
        x += cell_width * cell_span(character)


def render_terminal(
    source: str,
    columns: int,
    rows: int,
    font: ImageFont.FreeTypeFont,
) -> Image.Image:
    cell_width = round(font.getlength("M"))
    line_height = 22
    padding = 22
    width = padding * 2 + columns * cell_width
    height = padding * 2 + rows * line_height
    image = Image.new("RGB", (width, height), GROUND)
    draw = ImageDraw.Draw(image)
    for index, line in enumerate(source.splitlines()):
        draw_ansi_line(draw, line, (padding, padding + index * line_height), font, cell_width)
    return image


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: render-preview-gif.py previews.json font.ttf output-dir")
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    font = ImageFont.truetype(sys.argv[2], 16)
    output_dir = Path(sys.argv[3])
    output_dir.mkdir(parents=True, exist_ok=True)

    dashboard = payload["previews"]["dashboard"]
    frames = [
        render_terminal(source, dashboard["columns"], dashboard["rows"], font).quantize(
            colors=128,
            method=Image.Quantize.MEDIANCUT,
        )
        for source in dashboard["frames"]
    ]
    frames[0].save(
        output_dir / "fleet-console-dashboard.gif",
        save_all=True,
        append_images=frames[1:],
        duration=320,
        loop=0,
        optimize=False,
        disposal=2,
    )

    session = payload["previews"]["session"]
    render_terminal(session["frame"], session["columns"], session["rows"], font).save(
        output_dir / "fleet-console-session.png",
        optimize=True,
    )


if __name__ == "__main__":
    main()
