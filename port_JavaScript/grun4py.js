// ******* GRUN (Grammar Unit Test) for Python *******
'use strict';

import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import iconv from "iconv-lite";

import { CharStreams, CommonTokenStream, Token } from "antlr4";
import PythonLexer from "./PythonLexer.js";
import PythonParser from "./PythonParser.js";

// Encoding detection constants
const Encodings = {
    UTF8: "utf-8",
    UTF8_BOM: [0xef, 0xbb, 0xbf],
    UTF32_BE_BOM: [0x00, 0x00, 0xfe, 0xff],
    UTF32_LE_BOM: [0xff, 0xfe, 0x00, 0x00],
    UTF16_BE_BOM: [0xfe, 0xff],
    UTF16_LE_BOM: [0xff, 0xfe],
    MAX_BOM_LENGTH: 4,

    MAX_ASCII: 0x7f,
};

class Grun4py {
    static DEFAULT_ENCODING = PythonLexer.DEFAULT_ENCODING; // Python 2 = ASCII, Python 3 = utf-8
    static ENCODING_REGEX = /^[ \t\f]*#.*?coding[:=][ \t]*([-_.a-zA-Z0-9]+)/;
    static COMMENT_REGEX = /^[ \t\f]*(#.*)?$/;

    static ENCODING_MAP = {
        // UTF‑8
        utf8sig: "utf-8",
        utf8: "utf-8",
        utf: "utf-8",
        // UTF‑16 LE
        utf16le: "utf-16-le",
        utf16: "utf-16-le",
        ucs2: "utf-16-le",
        ucs2le: "utf-16-le",
        // ISO‑8859‑1 / Latin‑1
        latin1: "latin-1",
        latin: "latin-1",
        iso88591: "latin-1",
        iso8859: "latin-1",
        cp819: "latin-1",
        // ASCII
        ascii: "ascii",
        usascii: "ascii",
        ansix341968: "ascii",
        cp367: "ascii",
        // Deprecated alias
        binary: "latin-1",
    };

    static main(args) {
        if (args.length < 1) {
            console.log(
                "\n" +
                "------------------------------\n" +
                "USAGE:\n" +
                "npx tsx grun4py.ts filename.py\n" +
                "\n" +
                "------------------------------\n" +
                "TOKEN OUTPUT FORMAT:\n" +
                "[@TokenIndex,StartIndex:StopIndex='TokenText',<TokenName>,Channel,Line:Column]\n" +
                "Channel is optional. Lines are 1-based; columns are 0-based.\n" +
                "\n" +                
                "------------------------------"
            );

            process.exit(1);
        }

        const filePath = args[0];

        try {
            const sourceEncoding = this.detectEncoding(filePath);
            const text = this.readFileWithEncoding(filePath, sourceEncoding);
            const input = CharStreams.fromString(text);

            const lexer = new PythonLexer(input);
            lexer.setEncoding(sourceEncoding); // generate ENCODING token

            const tokens = new CommonTokenStream(lexer);
            const parser = new PythonParser(tokens);

            tokens.fill();
            for (const token of tokens.tokens) {
                console.log(this.formatToken(token));
            }

            parser.file_input();
            process.exit(parser.syntaxErrorsCount);
        } catch (ex) {
            console.error("Error: " + (ex instanceof Error ? ex.message : String(ex)));
            process.exit(1);
        }
    }

    static readFileWithEncoding(filePath, sourceEncoding) {
        // IMPORTANT: Decode the file using the detected source encoding before
        // creating the ANTLR CharStream. This ensures that encoding errors are
        // detected before lexical analysis and that the lexer receives decoded text.

        try {
            const buffer = fs.readFileSync(filePath);
            if (this.isUTF8(sourceEncoding)) {
                const decoder = new TextDecoder("utf-8", { fatal: true });
                return decoder.decode(buffer);
            }
            return iconv.decode(buffer, sourceEncoding);
        } catch (ex) {
            throw new Error(`Failed to decode file with encoding '${sourceEncoding}': ` + `${ex instanceof Error ? ex.message : String(ex)}`,{ cause: ex });
        }
    }

    // ---------- Token formatting ----------

    static formatToken(token) {
        const tokenText = this.escapeSpecialChars(token.text ?? "");
        const tokenName =
            token.type === Token.EOF
                ? "EOF"
                : PythonLexer.symbolicNames[token.type];

        const channelName =
            token.channel === Token.DEFAULT_CHANNEL
                ? ""
                : `channel=${PythonLexer.channelNames[token.channel]},`;

        return `[@${token.tokenIndex},${token.start}:${token.stop}='${tokenText}',<${tokenName}>,${channelName}${token.line}:${token.column}]`;
    }

    static escapeSpecialChars(text) {
        return text
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t")
            .replace(/\f/g, "\\f");
    }

    // ---------- Encoding detection ----------

    static detectEncoding(filePath) {
        const hasUTF8BOM = this.detectBOM(filePath);
        const commentEnc = this.detectEncodingFromComments(filePath, hasUTF8BOM);
        return this.resolveFinalEncoding(filePath, hasUTF8BOM, commentEnc);
    }

    static detectBOM(filePath) {
        const buffer = Buffer.alloc(Encodings.MAX_BOM_LENGTH);
        const fd = fs.openSync(filePath, "r");

        try {
            const bytesRead = fs.readSync(fd, buffer, 0, Encodings.MAX_BOM_LENGTH, 0);
            if (this.bufferStartsWith(buffer, bytesRead, Encodings.UTF8_BOM)) return true;
            if (this.bufferStartsWith(buffer, bytesRead, Encodings.UTF32_BE_BOM)) throw this.bomError(filePath, "UTF-32 BE BOM");
            if (this.bufferStartsWith(buffer, bytesRead, Encodings.UTF32_LE_BOM)) throw this.bomError(filePath, "UTF-32 LE BOM");
            if (this.bufferStartsWith(buffer, bytesRead, Encodings.UTF16_BE_BOM)) throw this.bomError(filePath, "UTF-16 BE BOM");
            if (this.bufferStartsWith(buffer, bytesRead, Encodings.UTF16_LE_BOM)) throw this.bomError(filePath, "UTF-16 LE BOM");
            return false;
        } finally {
            fs.closeSync(fd);
        }
    }

    static bufferStartsWith(buffer, bytesRead, prefix) {
        if (bytesRead < prefix.length) return false;
        return prefix.every((byte, i) => buffer[i] === byte);
    }

    static bomError(filePath, msg) {
        return new Error(
            `Invalid BOM encoding for '${path.basename(filePath)}': ${msg}`
        );
    }

    static detectEncodingFromComments(filePath, hasUTF8BOM) {
        const fd = fs.openSync(filePath, "r");
        const startPos = hasUTF8BOM ? Encodings.UTF8_BOM.length : 0;

        try {
            if (startPos > 0) {
                fs.readSync(fd, Buffer.alloc(startPos), 0, startPos, null);
            }

            for (let lineNum = 0; lineNum < 2; lineNum++) {
                const line = this.readAsciiLine(fd);
                if (line === null) return "";

                if (this.COMMENT_REGEX.test(line)) {
                    const enc = this.extractEncodingFromLine(line);
                    if (enc) return enc; // encoding found in comment
                } else {
                    break; // statement or backslash found (the line is not blank, not whitespace(s), not comment)
                }
            }
            return "";
        } finally {
            fs.closeSync(fd);
        }
    }

    static readAsciiLine(fd) {
        const buf = Buffer.alloc(1);
        const lineBuilder = [];
        while (fs.readSync(fd, buf, 0, 1, null) !== 0) {
            const ascii = buf[0];
            if (ascii > Encodings.MAX_ASCII) return null;
            if (ascii === "\n".charCodeAt(0)) break;
            if (ascii !== "\r".charCodeAt(0)) lineBuilder.push(String.fromCharCode(ascii));
        }
        return lineBuilder.join("");
    }

    static extractEncodingFromLine(line) {
        const match = line.match(this.ENCODING_REGEX);
        if (!match?.[1]) return "";
        return this.normalizeEncoding(match[1]);
    }

    static normalizeEncoding(enc) {
        if (!enc) return enc;

        const normalized = enc
            .toLowerCase()
            .replace(/[_\-\s]/g, "")
            .replace(/codec$/, "");

        return this.ENCODING_MAP[normalized] ?? enc;
    }

    static resolveFinalEncoding(filePath, hasUTF8BOM, commentEncoding) {
        const hasConflict =
            commentEncoding &&
            hasUTF8BOM &&
            !this.isUTF8(commentEncoding);

        if (hasConflict) {
            throw new Error(
                `Encoding problem for '${path.basename(filePath)}': ${this.DEFAULT_ENCODING} BOM`
            );
        }

        return commentEncoding || this.DEFAULT_ENCODING;
    }

    static isUTF8(enc) {
        return enc.replace(/[-_]/g, "").toLowerCase() === "utf8";
    }
}

// Entry point
Grun4py.main(process.argv.slice(2));
