import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.build_hakka_dictionary import (
    ACCENTS,
    ACCENT_KEYS,
    add_quiz_audio_pack,
    audio_urls,
    build_dictionary,
    first_quiz_sentence,
    normalize_whitespace,
    select_quiz_audio,
)


HEADERS = (
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


def xml_escape(value):
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def write_ods(path, rows):
    xml_rows = []
    for row in (HEADERS, *rows):
        cells = "".join(
            '<table:table-cell office:value-type="string">'
            f"<text:p>{xml_escape(value)}</text:p>"
            "</table:table-cell>"
            for value in row
        )
        xml_rows.append(f"<table:table-row>{cells}</table:table-row>")
    content = (
        "<?xml version='1.0' encoding='UTF-8'?>"
        '<office:document-content office:version="1.2" '
        'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
        'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">'
        "<office:body><office:spreadsheet><table:table>"
        f"{''.join(xml_rows)}"
        "</table:table></office:spreadsheet></office:body>"
        "</office:document-content>"
    )
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("content.xml", content)


class BuildHakkaDictionaryTests(unittest.TestCase):
    def test_normalizes_only_whitespace(self):
        self.assertEqual(normalize_whitespace("  假想。\n對象　甲  "), "假想。 對象 甲")
        self.assertEqual(normalize_whitespace("ＡＢ，詞。"), "ＡＢ，詞。")

    def test_audio_names_become_safe_official_urls(self):
        self.assertEqual(
            audio_urls(
                "　hk0000014108-1-1　/static/audio/hk0000014108-2-1.mp3 "
                "https://hakkadict.moe.edu.tw/static/audio/hk0000014108-3-1.mp3　"
                "../hk0000000000 https://evil.example/hk0000000000.mp3"
            ),
            [
                "https://hakkadict.moe.edu.tw/static/audio/hk0000014108-1-1.mp3",
                "https://hakkadict.moe.edu.tw/static/audio/hk0000014108-2-1.mp3",
                "https://hakkadict.moe.edu.tw/static/audio/hk0000014108-3-1.mp3",
            ],
        )

    def test_quiz_answer_is_unchanged_short_complete_first_sentence(self):
        self.assertEqual(first_quiz_sentence("假想。後句說明。"), "假想。")
        self.assertIsNone(first_quiz_sentence("1.第一義。 2.第二義。"))
        self.assertIsNone(first_quiz_sentence("沒有句號"))
        self.assertIsNone(first_quiz_sentence("這是一個超過二十八個字而不適合拿來當作四選一答案的完整官方釋義句子。"))

    def test_builds_six_accent_entry_and_keeps_homographs_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = []
            for index, accent in enumerate(ACCENTS, start=1):
                path = Path(directory) / f"{index}.ods"
                rows = [
                    (
                        "1",
                        "想像",
                        "動",
                        "詞目分類索引/思維心態",
                        f"pronunciation {index}",
                        "",
                        " 假想。　對不在眼前的事物。 ",
                        "官方例句。",
                        "聯想",
                        "",
                        f" hk0000014108-1-{index} ",
                    ),
                    (
                        "2",
                        "同形",
                        "名",
                        "",
                        "a",
                        "",
                        "第一個意思。",
                        "",
                        "",
                        "",
                        "",
                    ),
                    (
                        "3",
                        "同形",
                        "名",
                        "",
                        "b",
                        "",
                        "第二個意思。",
                        "",
                        "",
                        "",
                        "",
                    ),
                    (
                        "4",
                        "共音",
                        "動",
                        "",
                        "c",
                        "",
                        "第一個意思。",
                        "",
                        "",
                        "",
                        f"hk0000099999-1-{index}",
                    ),
                    (
                        "5",
                        "共音",
                        "形",
                        "",
                        "c",
                        "",
                        "另一個意思。",
                        "",
                        "",
                        "",
                        f"hk0000099999-1-{index}",
                    ),
                ]
                write_ods(path, rows)
                paths.append(path)

            dictionary = build_dictionary(paths, "2026-07-14")
            imagination = [
                entry for entry in dictionary["entries"] if entry["headword"] == "想像"
            ]
            self.assertEqual(len(imagination), 1)
            self.assertEqual(imagination[0]["quiz_answer"], "假想。")
            self.assertEqual(
                [variant["accent"] for variant in imagination[0]["variants"]],
                list(ACCENTS),
            )
            self.assertEqual(
                imagination[0]["variants"][0]["categories"], ["思維心態"]
            )
            self.assertEqual(
                len([entry for entry in dictionary["entries"] if entry["headword"] == "同形"]),
                2,
            )
            self.assertEqual(
                len([entry for entry in dictionary["entries"] if entry["headword"] == "共音"]),
                2,
            )
            self.assertEqual(dictionary["metadata"]["row_count"], 30)
            self.assertEqual(dictionary["metadata"]["headword_count"], 3)

    def test_quiz_pack_selection_and_cached_bytes_are_deterministic(self):
        entries = []
        for index in range(5):
            variants = []
            for accent_index, accent in enumerate(ACCENTS, start=1):
                variants.append(
                    {
                        "accent": accent,
                        "audio": [
                            "https://hakkadict.moe.edu.tw/static/audio/"
                            f"hk{index:010d}-1-{accent_index}.mp3"
                        ],
                    }
                )
            entries.append(
                {
                    "id": f"entry-{index}",
                    "headword": f"詞{index}",
                    "quiz_answer": f"答案{index}。",
                    "variants": variants,
                }
            )
        dictionary = {"metadata": {}, "entries": entries}
        first = select_quiz_audio(dictionary, 3)
        second = select_quiz_audio(dictionary, 3)
        self.assertEqual(
            [[url for _variant, url in first[accent]] for accent in ACCENTS],
            [[url for _variant, url in second[accent]] for accent in ACCENTS],
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "data" / "dictionary.json"
            audio_root = root / "assets" / "hakka-audio"
            for accent, items in first.items():
                folder = audio_root / ACCENT_KEYS[accent]
                folder.mkdir(parents=True, exist_ok=True)
                for _variant, url in items:
                    (folder / Path(url).name).write_bytes(b"original-mp3-bytes")

            add_quiz_audio_pack(dictionary, output, audio_root, 3, workers=2)
            metadata = dictionary["metadata"]["quiz_audio"]
            self.assertEqual(metadata["total_count"], 18)
            self.assertEqual(metadata["total_bytes"], 18 * len(b"original-mp3-bytes"))
            for accent, items in first.items():
                self.assertEqual(metadata["accents"][accent]["count"], 3)
                for variant, _url in items:
                    self.assertTrue(
                        variant["quiz_audio"].startswith(
                            f"../assets/hakka-audio/{ACCENT_KEYS[accent]}/"
                        )
                    )


if __name__ == "__main__":
    unittest.main()
