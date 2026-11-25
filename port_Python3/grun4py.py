#!/usr/bin/env python3
# ******* GRUN (Grammar Unit Test) for Python *******

import sys
import codecs
import re
import pathlib

from antlr4 import InputStream, CommonTokenStream, Token
from PythonLexer import PythonLexer
from PythonParser import PythonParser


# Encoding detection constants
class Encodings:
    UTF8 = "utf-8"
    UTF8_BOM = bytes([0xef, 0xbb, 0xbf])
    UTF32_BE_BOM = bytes([0x00, 0x00, 0xfe, 0xff])
    UTF32_LE_BOM = bytes([0xff, 0xfe, 0x00, 0x00])
    UTF16_BE_BOM = bytes([0xfe, 0xff])
    UTF16_LE_BOM = bytes([0xff, 0xfe])
    MAX_BOM_LENGTH = 4

    MAX_ASCII = 0x7f

class Grun4py:
    _DEFAULT_ENCODING = PythonLexer.DEFAULT_ENCODING # Python 2 = ASCII, Python 3 = utf-8
    _ENCODING_REGEX = re.compile(r'^[ \t\f]*#.*?coding[:=][ \t]*([-_.a-zA-Z0-9]+)')
    _COMMENT_REGEX = re.compile(r'^[ \t\f]*(#.*)?$')
    _ENCODING_MAP = {
        # UTF‑8
        "utf8sig": "utf-8",
        "utf8": "utf-8",
        "utf": "utf-8",
        # UTF‑16 LE
        "utf16le": "utf-16-le",
        "utf16": "utf-16-le",
        "ucs2": "utf-16-le",
        "ucs2le": "utf-16-le",
        # ISO‑8859‑1 / Latin‑1
        "latin1": "latin-1",
        "latin": "latin-1",
        "iso88591": "latin-1",
        "iso8859": "latin-1",
        "cp819": "latin-1",
        # ASCII
        "ascii": "ascii",
        "usascii": "ascii",
        "ansix341968": "ascii",
        "cp367": "ascii",
        # Deprecated alias
        "binary": "latin-1",
    }

    @staticmethod
    def main(args):
        if len(args) < 1:
            print(
                "\n"
                "------------------------------\n"
                "USAGE:\n"
                "python grun4py.py filename.py\n"
                "\n"
                "------------------------------\n"
                "TOKEN OUTPUT FORMAT:\n"
                "[@TokenIndex,StartIndex:StopIndex='TokenText',<TokenName>,Channel,Line:Column]\n"
                "Channel is optional. Lines are 1-based; columns are 0-based.\n"
                "\n"
                "------------------------------\n"
            )
            sys.exit(1)

        file_path = pathlib.Path(args[0])

        try:
            source_encoding = Grun4py.detect_encoding(file_path)
            text = Grun4py.read_file_with_encoding(file_path, source_encoding)
            input_stream = InputStream(text)

            lexer = PythonLexer(input_stream)
            lexer.set_encoding(source_encoding)  # generate ENCODING token

            tokens = CommonTokenStream(lexer)
            parser = PythonParser(tokens)

            tokens.fill()
            for token in tokens.tokens:
                print(Grun4py.format_token(token))

            parser.file_input()
            sys.exit(parser.getNumberOfSyntaxErrors())
        except Exception as ex:
            print("Error: " + str(ex), file=sys.stderr)
            sys.exit(1)

    @staticmethod
    def read_file_with_encoding(file_path, source_encoding):
        # IMPORTANT: Decode the file using the detected source encoding before
        # creating the ANTLR CharStream. This ensures that encoding errors are
        # detected before lexical analysis and that the lexer receives decoded text.

        try:
            with open(file_path, "rb") as f:
                data = f.read()
            return codecs.decode(data, source_encoding)
        except (LookupError, UnicodeDecodeError) as ex:
            raise RuntimeError(f"Failed to decode file with encoding '{source_encoding}': {ex}") from ex

    # ---------- Token formatting ----------

    @staticmethod
    def format_token(token: Token) -> str:
        token_text = Grun4py.escape_special_chars(token.text or "")
        token_name = "EOF" if token.type == Token.EOF else PythonLexer.symbolicNames[token.type]

        channel_name = "" if token.channel == Token.DEFAULT_CHANNEL else f"channel={PythonLexer.channelNames[token.channel]},"

        return f"[@{token.tokenIndex},{token.start}:{token.stop}='{token_text}',<{token_name}>,{channel_name}{token.line}:{token.column}]"

    @staticmethod
    def escape_special_chars(text: str) -> str:
        return (
                text
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t")
                .replace("\f", "\\f")
        )

    # ---------- Encoding detection ----------

    @staticmethod
    def detect_encoding(file_path: str) -> str:
        has_utf8_bom = Grun4py.detect_bom(file_path)
        comment_enc = Grun4py.detect_encoding_from_comments(file_path, has_utf8_bom)
        return Grun4py.resolve_final_encoding(file_path, has_utf8_bom, comment_enc)

    @staticmethod
    def detect_bom(file_path: str) -> bool:
        with open(file_path, "rb") as f:
            header = f.read(Encodings.MAX_BOM_LENGTH)

        if header.startswith(Encodings.UTF8_BOM):
            return True
        if header.startswith(Encodings.UTF32_BE_BOM):
            raise Grun4py.bom_error(file_path, "UTF-32 BE BOM")
        if header.startswith(Encodings.UTF32_LE_BOM):
            raise Grun4py.bom_error(file_path, "UTF-32 LE BOM")
        if header.startswith(Encodings.UTF16_BE_BOM):
            raise Grun4py.bom_error(file_path, "UTF-16 BE BOM")
        if header.startswith(Encodings.UTF16_LE_BOM):
            raise Grun4py.bom_error(file_path, "UTF-16 LE BOM")

        return False

    @staticmethod
    def bom_error(file_path: str, msg: str) -> Exception:
        return RuntimeError(f"Invalid BOM encoding for '{pathlib.Path(file_path).name}': {msg}")

    @staticmethod
    def detect_encoding_from_comments(file_path: str, has_utf8_bom: bool) -> str:
        with open(file_path, "rb") as f:
            start_pos = len(Encodings.UTF8_BOM) if has_utf8_bom else 0
            if start_pos:
                f.seek(start_pos)

            for _ in range(2):
                line = Grun4py.read_ascii_line(f)
                if line is None:
                    return ""

                if Grun4py._COMMENT_REGEX.match(line):
                    enc = Grun4py.extract_encoding_from_line(line)
                    if enc:
                        return enc  # encoding found in comment
                else:
                    break  # statement or backslash found (the line is not blank, not whitespace(s), not comment)

        return ""

    @staticmethod
    def read_ascii_line(f) -> str | None:
        lineBuilder = []
        while True:
            buff = f.read(1)
            if not buff:
                break

            ascii = buff[0]
            if ascii > Encodings.MAX_ASCII:
                return None
            if ascii == ord("\n"):
                break
            if ascii != ord("\r"):
                lineBuilder.append(chr(ascii))

        return "".join(lineBuilder)

    @staticmethod
    def extract_encoding_from_line(line: str) -> str:
        m = Grun4py._ENCODING_REGEX.match(line)
        if not m or not m.group(1):
            return ""
        return Grun4py.normalize_encoding(m.group(1))

    @staticmethod
    def normalize_encoding(enc: str) -> str:
        if not enc:
            return enc

        normalized = (
            enc.lower()
            .replace("_", "")
            .replace("-", "")
            .replace(" ", "")
            .removesuffix("codec")
        )

        return Grun4py._ENCODING_MAP.get(normalized, enc)

    @staticmethod
    def resolve_final_encoding(file_path: str, has_utf8_bom: bool, comment_encoding: str) -> str:
        has_conflict = (
            comment_encoding
            and has_utf8_bom
            and not Grun4py.is_utf8(comment_encoding)
        )

        if has_conflict:
            raise RuntimeError(
                f"Encoding problem for '{pathlib.Path(file_path).name}': {Grun4py._DEFAULT_ENCODING} BOM"
            )

        return comment_encoding or Grun4py._DEFAULT_ENCODING

    @staticmethod
    def is_utf8(enc: str) -> bool:
        return enc.replace("-", "").replace("_", "").lower() == "utf8"


# Entry point
if __name__ == "__main__":
    Grun4py.main(sys.argv[1:])
