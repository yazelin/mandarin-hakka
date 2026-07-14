#!/usr/bin/env python3
"""Build the Mandarin–Hakka dictionary from the Ministry of Education ODS files.

The source text is kept verbatim except that runs of Unicode whitespace are
collapsed to one ASCII space and leading/trailing whitespace is removed.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Iterable, Iterator, Sequence
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, urlopen


ACCENTS = ("四縣", "海陸", "大埔", "饒平", "詔安", "南四縣")
ACCENT_KEYS = {
    "四縣": "sixian",
    "海陸": "hailu",
    "大埔": "dapu",
    "饒平": "raoping",
    "詔安": "zhaoan",
    "南四縣": "south-sixian",
}
REQUIRED_COLUMNS = (
    "序號",
    "詞目",
    "詞性",
    "詞目索引",
    "音讀",
    "方言點",
    "釋義",
    "例句",
    "相似詞",
    "相反詞",
    "對應音檔名稱",
)

SOURCE_NAME = "教育部臺灣客語辭典"
SOURCE_URL = "https://hakkadict.moe.edu.tw/"
SOURCE_DOWNLOAD_URL = "https://hakkadict.moe.edu.tw/resource_download/"
LICENSE_NAME = "CC BY-ND 3.0 TW"
LICENSE_URL = "https://creativecommons.org/licenses/by-nd/3.0/tw/"
AUDIO_BASE_URL = "https://hakkadict.moe.edu.tw/static/audio/"

OFFICE_NS = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
TABLE_NS = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
TEXT_NS = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
ROW_TAG = f"{{{TABLE_NS}}}table-row"
CELL_TAG = f"{{{TABLE_NS}}}table-cell"
COVERED_CELL_TAG = f"{{{TABLE_NS}}}covered-table-cell"
PARAGRAPH_TAG = f"{{{TEXT_NS}}}p"
SPACE_TAG = f"{{{TEXT_NS}}}s"
TAB_TAG = f"{{{TEXT_NS}}}tab"
LINE_BREAK_TAG = f"{{{TEXT_NS}}}line-break"
COLUMN_REPEAT = f"{{{TABLE_NS}}}number-columns-repeated"
ROW_REPEAT = f"{{{TABLE_NS}}}number-rows-repeated"
SPACE_COUNT = f"{{{TEXT_NS}}}c"

WHITESPACE_RE = re.compile(r"[\s\u3000]+", re.UNICODE)
CATEGORY_RE = re.compile(r"詞目分類索引/([^\s/]+)")
AUDIO_FILENAME_RE = re.compile(r"hk[0-9A-Za-z._-]+", re.IGNORECASE)
AUDIO_CORE_RE = re.compile(r"(hk\d+)", re.IGNORECASE)
NUMBERED_SENSE_RE = re.compile(
    r"(?:^|\s)(?:[1-9]\d*[.．、]|[（(][一二三四五六七八九十]+[）)])"
)
SENTENCE_END_RE = re.compile(r"[。！？!?]")


def normalize_whitespace(value: object) -> str:
    """Trim and collapse whitespace without changing any non-whitespace text."""

    return WHITESPACE_RE.sub(" ", "" if value is None else str(value)).strip()


def _inline_text(element: ET.Element) -> str:
    parts: list[str] = []
    if element.text:
        parts.append(element.text)
    for child in element:
        if child.tag == SPACE_TAG:
            try:
                count = max(1, int(child.get(SPACE_COUNT, "1")))
            except ValueError:
                count = 1
            parts.append(" " * count)
        elif child.tag == TAB_TAG:
            parts.append("\t")
        elif child.tag == LINE_BREAK_TAG:
            parts.append("\n")
        else:
            parts.append(_inline_text(child))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


def _cell_text(cell: ET.Element) -> str:
    paragraphs = list(cell.iter(PARAGRAPH_TAG))
    raw = "\n".join(_inline_text(paragraph) for paragraph in paragraphs)
    if not paragraphs:
        raw = _inline_text(cell)
    return normalize_whitespace(raw)


def iter_ods_rows(path: Path) -> Iterator[list[str]]:
    """Yield normalized cell values from an ODS spreadsheet."""

    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as error:
        raise ValueError(f"無法讀取 ODS：{path}") from error

    with archive:
        try:
            content = archive.open("content.xml")
        except KeyError as error:
            raise ValueError(f"ODS 缺少 content.xml：{path}") from error

        with content:
            for _event, element in ET.iterparse(content, events=("end",)):
                if element.tag != ROW_TAG:
                    continue

                values: list[str] = []
                for cell in element:
                    if cell.tag not in (CELL_TAG, COVERED_CELL_TAG):
                        continue
                    try:
                        repeat = max(1, int(cell.get(COLUMN_REPEAT, "1")))
                    except ValueError:
                        repeat = 1
                    value = "" if cell.tag == COVERED_CELL_TAG else _cell_text(cell)
                    values.extend([value] * repeat)

                while values and not values[-1]:
                    values.pop()

                try:
                    row_repeat = max(1, int(element.get(ROW_REPEAT, "1")))
                except ValueError:
                    row_repeat = 1
                if values:
                    for _ in range(row_repeat):
                        yield list(values)
                element.clear()


def _safe_audio_url(token: str) -> str | None:
    token = token.strip(" ,;，；")
    if not token:
        return None

    parsed = urlsplit(token)
    if parsed.scheme or parsed.netloc:
        if parsed.scheme.lower() != "https" or parsed.hostname != "hakkadict.moe.edu.tw":
            return None
        if parsed.query or parsed.fragment:
            return None
        raw_path = unquote(parsed.path)
        marker = "/static/audio/"
        if marker not in raw_path:
            return None
        raw_path = raw_path.split(marker, 1)[1]
    else:
        if parsed.query or parsed.fragment:
            return None
        raw_path = unquote(parsed.path).lstrip("/")
        for prefix in ("static/audio/", "audio/"):
            if raw_path.startswith(prefix):
                raw_path = raw_path[len(prefix) :]
                break

    path = PurePosixPath(raw_path)
    if not raw_path or path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        return None

    filename = path.name
    if "." not in filename:
        filename = f"{filename}.mp3"
        path = path.with_name(filename)
    if path.suffix.lower() != ".mp3" or not AUDIO_FILENAME_RE.fullmatch(path.stem):
        return None

    encoded_path = "/".join(quote(part, safe="-._~") for part in path.parts)
    return f"{AUDIO_BASE_URL}{encoded_path}"


def audio_urls(value: str) -> list[str]:
    """Convert the source audio-name cell into safe, official HTTPS URLs."""

    result: list[str] = []
    seen: set[str] = set()
    for token in WHITESPACE_RE.split(value.strip()):
        url = _safe_audio_url(token)
        if url and url not in seen:
            seen.add(url)
            result.append(url)
    return result


def _audio_core_ids(urls: Iterable[str]) -> tuple[str, ...]:
    result: list[str] = []
    seen: set[str] = set()
    for url in urls:
        match = AUDIO_CORE_RE.search(PurePosixPath(urlsplit(url).path).name)
        if not match:
            continue
        core = match.group(1).lower()
        if core not in seen:
            seen.add(core)
            result.append(core)
    return tuple(result)


def categories(value: str) -> list[str]:
    return list(dict.fromkeys(CATEGORY_RE.findall(value)))


def _sequence(value: str) -> int | str:
    return int(value) if value.isdecimal() else value


def read_accent_rows(path: Path, accent: str) -> list[dict]:
    rows = iter_ods_rows(path)
    try:
        header = next(rows)
    except StopIteration as error:
        raise ValueError(f"ODS 沒有資料：{path}") from error

    column_index = {name: index for index, name in enumerate(header)}
    missing = [name for name in REQUIRED_COLUMNS if name not in column_index]
    if missing:
        raise ValueError(f"ODS 欄位不完整（{path}）：{', '.join(missing)}")

    records: list[dict] = []
    for cells in rows:
        def get(name: str) -> str:
            index = column_index[name]
            return cells[index] if index < len(cells) else ""

        headword = get("詞目")
        if not headword:
            continue
        urls = audio_urls(get("對應音檔名稱"))
        record = {
            "accent": accent,
            "sequence": _sequence(get("序號")),
            "headword": headword,
            "part_of_speech": get("詞性"),
            "pronunciation": get("音讀"),
            "location": get("方言點"),
            "definition": get("釋義"),
            "example": get("例句"),
            "synonyms": get("相似詞"),
            "antonyms": get("相反詞"),
            "categories": categories(get("詞目索引")),
            "audio": urls,
            "_audio_cores": _audio_core_ids(urls),
        }
        records.append(record)
    return records


def first_quiz_sentence(definition: str) -> str | None:
    """Return an unchanged, short first sentence only for an unnumbered sense."""

    if not definition or NUMBERED_SENSE_RE.search(definition):
        return None
    match = SENTENCE_END_RE.search(definition)
    if not match:
        return None
    sentence = definition[: match.end()]
    length = len(sentence)
    if not 2 <= length <= 28:
        return None
    if any(character in sentence for character in ("\n", "\r", "\t", "|", "http://", "https://")):
        return None
    return sentence


def _group_key(row: dict) -> tuple:
    cores = row["_audio_cores"]
    if cores:
        # The first file is the row's primary recording. Additional files are
        # alternate readings and can carry a different core ID, so they must not
        # split this row away from the same entry in the other accents. The
        # headword guard prevents a reused recording from merging aliases.
        return ("audio", row["headword"], cores[0])
    return (
        "text",
        row["headword"],
        row["part_of_speech"],
        row["definition"],
    )


def _semantic_signature(row: dict) -> tuple[str, str]:
    return (row["part_of_speech"], row["definition"])


def _group_rows(rows: Iterable[dict]) -> dict[tuple, list[dict]]:
    """Group accents while splitting a recording reused by distinct homographs."""

    base_groups: dict[tuple, list[dict]] = defaultdict(list)
    for row in rows:
        base_groups[_group_key(row)].append(row)

    result: dict[tuple, list[dict]] = {}
    for base_key, base_rows in base_groups.items():
        signatures_by_accent: dict[str, set[tuple[str, str]]] = defaultdict(set)
        for row in base_rows:
            signatures_by_accent[row["accent"]].add(_semantic_signature(row))
        reused_for_multiple_senses = base_key[0] == "audio" and any(
            len(signatures) > 1 for signatures in signatures_by_accent.values()
        )
        if not reused_for_multiple_senses:
            result[base_key] = base_rows
            continue

        # A small number of official rows reuse one recording for two meanings of
        # the same spelling. Exact official POS + definition keeps those meanings
        # separate; it also avoids attempting to rewrite or semantically infer text.
        sense_groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for row in base_rows:
            sense_groups[_semantic_signature(row)].append(row)
        for signature, sense_rows in sense_groups.items():
            result[(*base_key, "sense", *signature)] = sense_rows
    return result


def _entry_id(group_key: tuple) -> str:
    serialized = "\u0000".join(str(part) for part in group_key)
    digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()[:16]
    if group_key[0] == "audio":
        return f"{group_key[2]}-{digest[:8]}"
    return f"text-{digest}"


def _variant_sort_key(variant: dict) -> tuple:
    sequence = variant["sequence"]
    sequence_key = (0, sequence) if isinstance(sequence, int) else (1, str(sequence))
    return (
        ACCENTS.index(variant["accent"]),
        sequence_key,
        variant["pronunciation"],
        variant["definition"],
    )


def group_entries(rows: Iterable[dict]) -> list[dict]:
    grouped = _group_rows(rows)

    entries: list[dict] = []
    for group_key, grouped_rows in grouped.items():
        variants: list[dict] = []
        for row in sorted(grouped_rows, key=_variant_sort_key):
            variants.append(
                {
                    key: value
                    for key, value in row.items()
                    if key not in ("headword", "_audio_cores")
                }
            )
        entry = {
            "id": _entry_id(group_key),
            "headword": grouped_rows[0]["headword"],
            "variants": variants,
        }

        candidates = [first_quiz_sentence(variant["definition"]) for variant in variants]
        unique_candidates = {candidate for candidate in candidates if candidate}
        if all(candidates) and len(unique_candidates) == 1:
            entry["quiz_answer"] = unique_candidates.pop()
        entries.append(entry)

    entries.sort(key=lambda entry: (entry["headword"], entry["id"]))
    return entries


def source_date(paths: Sequence[Path]) -> str:
    """Use the newest ODS member timestamp as the reproducible source date."""

    dates: list[tuple[int, int, int]] = []
    for path in paths:
        with zipfile.ZipFile(path) as archive:
            dates.extend(info.date_time[:3] for info in archive.infolist())
    if not dates:
        raise ValueError("找不到 ODS 來源日期")
    year, month, day = max(dates)
    return f"{year:04d}-{month:02d}-{day:02d}"


def build_dictionary(paths: Sequence[Path], explicit_source_date: str | None = None) -> dict:
    if len(paths) != len(ACCENTS):
        raise ValueError(f"需要依序提供 {len(ACCENTS)} 份 ODS：{', '.join(ACCENTS)}")

    rows: list[dict] = []
    for accent, path in zip(ACCENTS, paths, strict=True):
        rows.extend(read_accent_rows(path, accent))

    entries = group_entries(rows)
    unique_audio = {
        audio
        for entry in entries
        for variant in entry["variants"]
        for audio in variant["audio"]
    }
    unique_headwords = {entry["headword"] for entry in entries}
    metadata = {
        "schema_version": 1,
        "source_name": SOURCE_NAME,
        "source_url": SOURCE_URL,
        "source_download_url": SOURCE_DOWNLOAD_URL,
        "source_date": explicit_source_date or source_date(paths),
        "license": {"name": LICENSE_NAME, "url": LICENSE_URL},
        "accents": list(ACCENTS),
        "row_count": len(rows),
        "entry_count": len(entries),
        "headword_count": len(unique_headwords),
        "audio_count": len(unique_audio),
    }
    return {"metadata": metadata, "entries": entries}


def _quiz_candidate_order(accent: str, entry: dict, variant: dict) -> bytes:
    value = "\u0000".join(
        (
            "mandarin-hakka-quiz-v1",
            accent,
            entry["id"],
            entry["headword"],
            entry["quiz_answer"],
            variant["audio"][0],
        )
    )
    return hashlib.sha256(value.encode("utf-8")).digest()


def select_quiz_audio(dictionary: dict, per_accent: int) -> dict[str, list[tuple[dict, str]]]:
    """Select a reproducible, non-repeating local quiz pack for every accent."""

    if per_accent < 1:
        raise ValueError("--quiz-audio-per-accent 必須大於 0")

    selected: dict[str, list[tuple[dict, str]]] = {}
    for accent in ACCENTS:
        candidates: list[tuple[bytes, dict, dict, str]] = []
        for entry in dictionary["entries"]:
            if "quiz_answer" not in entry:
                continue
            for variant in entry["variants"]:
                if variant["accent"] != accent or not variant["audio"]:
                    continue
                remote_url = variant["audio"][0]
                candidates.append(
                    (_quiz_candidate_order(accent, entry, variant), entry, variant, remote_url)
                )

        candidates.sort(key=lambda item: (item[0], item[1]["id"], item[3]))
        used_headwords: set[str] = set()
        used_answers: set[str] = set()
        used_filenames: set[str] = set()
        accent_selection: list[tuple[dict, str]] = []
        for _order, entry, variant, remote_url in candidates:
            filename = PurePosixPath(unquote(urlsplit(remote_url).path)).name
            if (
                entry["headword"] in used_headwords
                or entry["quiz_answer"] in used_answers
                or filename in used_filenames
            ):
                continue
            used_headwords.add(entry["headword"])
            used_answers.add(entry["quiz_answer"])
            used_filenames.add(filename)
            accent_selection.append((variant, remote_url))
            if len(accent_selection) == per_accent:
                break

        if len(accent_selection) != per_accent:
            raise ValueError(
                f"{accent}只有 {len(accent_selection)} 筆不重複題目，"
                f"不足 --quiz-audio-per-accent={per_accent}"
            )
        selected[accent] = accent_selection
    return selected


def _download_original_audio(remote_url: str, destination: Path) -> int:
    if destination.is_file() and destination.stat().st_size > 0:
        return destination.stat().st_size

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(f"{destination.suffix}.part")
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            request = Request(
                remote_url,
                headers={"User-Agent": "mandarin-hakka-data-builder/1.0"},
            )
            with urlopen(request, timeout=30) as response:  # noqa: S310 - allowlisted URL
                body = response.read()
                final_url = urlsplit(response.geturl())
            if final_url.scheme.lower() != "https" or final_url.hostname != "hakkadict.moe.edu.tw":
                raise ValueError(f"音檔被重新導向非官方來源：{response.geturl()}")
            if not body:
                raise ValueError(f"官方音檔是空檔案：{remote_url}")
            with temporary.open("wb") as stream:
                stream.write(body)
            temporary.replace(destination)
            return len(body)
        except (OSError, ValueError) as error:
            last_error = error
            if temporary.exists():
                temporary.unlink()
            if attempt < 2:
                time.sleep(0.25 * (attempt + 1))
    raise ValueError(f"下載官方音檔失敗：{remote_url}（{last_error}）")


def add_quiz_audio_pack(
    dictionary: dict,
    output: Path,
    audio_output: Path,
    per_accent: int,
    workers: int = 12,
) -> None:
    """Download selected MP3 bytes and add relative URLs to their variants."""

    selection = select_quiz_audio(dictionary, per_accent)
    downloads: list[tuple[str, dict, str, Path]] = []
    for accent, items in selection.items():
        folder = ACCENT_KEYS[accent]
        for variant, remote_url in items:
            filename = PurePosixPath(unquote(urlsplit(remote_url).path)).name
            destination = audio_output / folder / filename
            downloads.append((accent, variant, remote_url, destination))

    expected_by_folder: dict[Path, set[str]] = defaultdict(set)
    for _accent, _variant, _remote_url, destination in downloads:
        expected_by_folder[destination.parent].add(destination.name)
    for folder, expected_names in expected_by_folder.items():
        folder.mkdir(parents=True, exist_ok=True)
        for path in folder.iterdir():
            if path.is_file() and (
                (path.suffix.lower() == ".mp3" and path.name not in expected_names)
                or path.name.endswith(".part")
            ):
                path.unlink()

    byte_sizes: dict[Path, int] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = {
            executor.submit(_download_original_audio, remote_url, destination): destination
            for _accent, _variant, remote_url, destination in downloads
        }
        for future in concurrent.futures.as_completed(futures):
            destination = futures[future]
            byte_sizes[destination] = future.result()

    accent_metadata: dict[str, dict] = {}
    for accent in ACCENTS:
        accent_downloads = [item for item in downloads if item[0] == accent]
        total_bytes = 0
        for _accent, variant, _remote_url, destination in accent_downloads:
            relative = Path(os.path.relpath(destination, start=output.parent)).as_posix()
            variant["quiz_audio"] = quote(relative, safe="../-._~")
            total_bytes += byte_sizes[destination]
        accent_metadata[accent] = {
            "key": ACCENT_KEYS[accent],
            "count": len(accent_downloads),
            "bytes": total_bytes,
        }

    dictionary["metadata"]["quiz_audio"] = {
        "per_accent": per_accent,
        "total_count": sum(item["count"] for item in accent_metadata.values()),
        "total_bytes": sum(item["bytes"] for item in accent_metadata.values()),
        "accents": accent_metadata,
    }


def write_dictionary(dictionary: dict, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(f"{output.suffix}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(dictionary, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
    temporary.replace(output)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "ods",
        nargs=6,
        type=Path,
        metavar="ODS",
        help="依序提供四縣、海陸、大埔、饒平、詔安、南四縣 ODS",
    )
    parser.add_argument("--output", type=Path, default=Path("data/dictionary.json"))
    parser.add_argument(
        "--source-date",
        help="覆寫來源日期（YYYY-MM-DD）；預設取 ODS 內最新檔案日期",
    )
    parser.add_argument(
        "--quiz-audio-output",
        type=Path,
        help="下載精選測驗 MP3 的目錄，例如 assets/hakka-audio",
    )
    parser.add_argument(
        "--quiz-audio-per-accent",
        type=int,
        default=360,
        help="每腔精選且不重複的測驗音檔數（預設 360）",
    )
    parser.add_argument(
        "--download-workers",
        type=int,
        default=12,
        help="下載音檔的同時連線數（預設 12）",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        dictionary = build_dictionary(args.ods, args.source_date)
        if args.quiz_audio_output:
            add_quiz_audio_pack(
                dictionary,
                args.output,
                args.quiz_audio_output,
                args.quiz_audio_per_accent,
                args.download_workers,
            )
        write_dictionary(dictionary, args.output)
    except (OSError, ValueError, ET.ParseError, zipfile.BadZipFile) as error:
        print(f"建置失敗：{error}", file=sys.stderr)
        return 1

    metadata = dictionary["metadata"]
    print(
        f"完成 {args.output}：{metadata['row_count']:,} 筆腔別資料、"
        f"{metadata['entry_count']:,} 個詞義群組、"
        f"{metadata['headword_count']:,} 個不重複詞目、"
        f"{metadata['audio_count']:,} 個音檔"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
