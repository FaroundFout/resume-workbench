"""Validate and preserve the native XeLaTeX text layer.

Older versions rasterized the page and rebuilt an invisible text overlay. That
made wrapped paragraphs select only on alternating visual lines in some PDF
viewers. The LaTeX source now emits native text per rendered line, so the safe
"copy-friendly" build is the original vector PDF itself.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from pypdf import PdfReader, PdfWriter


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-pdf", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    # Retain the old command-line options so existing local build commands do
    # not fail. They are intentionally unused; no raster overlay is created.
    parser.add_argument("--page-image", type=Path)
    parser.add_argument("--font", type=Path)
    parser.add_argument("--font-size", type=float, default=10.0)
    parser.add_argument("--wrap-rise", type=float, default=0.0)
    parser.add_argument("--joiner-font-size", type=float, default=0.0)
    return parser.parse_args()


def build(args: argparse.Namespace) -> None:
    source = args.source_pdf.resolve()
    output = args.output.resolve()
    reader = PdfReader(str(source))
    if len(reader.pages) != 1:
        raise ValueError("Expected a one-page resume")

    extracted = reader.pages[0].extract_text() or ""
    physical_lines = [line for line in extracted.splitlines() if line.strip()]
    if len(physical_lines) < 40:
        raise ValueError(
            "The PDF text layer still collapses wrapped paragraphs; rebuild "
            "resume_zh.tex after updating custom-commands.tex"
        )
    if "\u2029" in extracted:
        raise ValueError("Unexpected paragraph markers found in the text layer")

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f"{output.stem}.validated.pdf")
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    with temporary.open("wb") as stream:
        writer.write(stream)
    temporary.replace(output)


if __name__ == "__main__":
    build(parse_args())
