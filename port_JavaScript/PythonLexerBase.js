/*
The MIT License (MIT)
Copyright (c) 2021 Robert Einhorn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
 */

/*
 *
 * Project      : A helper class for an ANTLR4 Python lexer grammar that assists in tokenizing indentation,
 *                interpolated strings, and encoding declaration. 
 *
 * Developed by : Robert Einhorn, robert.einhorn.hu@gmail.com
 *
 */

'use strict';

import { CharStreams, CommonTokenStream, Token, Lexer } from "antlr4";
import PythonLexer from "./PythonLexer.js";
import PythonParser from "./PythonParser.js";

export default class PythonLexerBase extends Lexer {
	// The default encoding for Python 3 source files without an encoding declaration (PEP 3120)
    static DEFAULT_ENCODING = "utf-8";
	
    static #TAB_LENGTH = 8;
    static #ERR_TXT = " ERROR: ";
    static #LEXER_MODES_FOR_ISTRING_START = new Map();

    #sourceEncoding = "";

    // Indentation handling
    #indentationLengthStack;

    // Queued tokens waiting to be emitted to the token stream
    #pendingTokenQueue;
	#previousPendingTokenType;
    #lastPendingTokenTypeFromDefaultChannel;

    // Parenthesis / bracket / brace counts
    #openParenBracketBraceCount;
    #parenOrBracketOpenedStack;
    #braceExpressionStack;
    #lastClosedBraceExpression;

    // Current interpolated STRING_MIDDLE token type (FSTRING_MIDDLE or TSTRING_MIDDLE)
    #activeInterpolatedStringMiddleTokenType;

    // We reimplement mode/modeStack because not all runtimes expose _mode/_modeStack
    #currentLexerMode;
    #lexerModeStack;

    // Current / lookahead tokens
    #curToken;
    #laToken;

    constructor(input) {
        super(input);
        this.#init();
    }

    reset() {
        super.reset();
        this.#init();
    }

    #init() {
        this.#sourceEncoding = "";
        this.#indentationLengthStack = [];
        this.#pendingTokenQueue = [];
        this.#previousPendingTokenType = 0;
        this.#lastPendingTokenTypeFromDefaultChannel = 0;
        this.#openParenBracketBraceCount = 0;
        this.#parenOrBracketOpenedStack = [];
        this.#braceExpressionStack = [];
        this.#lastClosedBraceExpression = "";
        this.#activeInterpolatedStringMiddleTokenType = 0;
        this.#currentLexerMode = Lexer.DEFAULT_MODE;
        this.#lexerModeStack = [];
        this.#curToken = null;
        this.#laToken = null;
    }

    /**
     * Sets the encoding to emit an ENCODING token at the start of the token stream.
     * Leave empty if not needed (e.g., when parsing from string).
     *
     * @param {string} encoding - The encoding (e.g., "utf-8"), or empty string to disable ENCODING token.
     */
    setEncoding(encoding) {
        this.#sourceEncoding = encoding;
    }

    nextToken() { // Reading the input stream until EOF is reached
        this.#processCurrentToken();
        return this.#pendingTokenQueue.shift() /* stack pollFirst() */; // Add the queued token to the token stream
    }

    #processCurrentToken() {
        if (this.#previousPendingTokenType === Token.EOF) {
            return;
        }

        this.#setCurrentAndLookAheadTokens();
        if (this.#indentationLengthStack.length === 0) { // We're at the first token
            this.#handleStartOfInput();
        }

        switch (this.#curToken.type) {
            case PythonLexer.NEWLINE:
                this.#handleNEWLINEtoken();
                break;
            case PythonLexer.LPAR:
            case PythonLexer.LSQB:
            case PythonLexer.LBRACE:
                this.#openParenBracketBraceCount++;
                this.#addPendingToken(this.#curToken);
                break;
            case PythonLexer.RPAR:
            case PythonLexer.RSQB:
            case PythonLexer.RBRACE:
                this.#openParenBracketBraceCount--;
                this.#addPendingToken(this.#curToken);
                break;
            case PythonLexer.FSTRING_MIDDLE:
            case PythonLexer.TSTRING_MIDDLE:
                this.#handleFSTRING_MIDDLEtokenWithDoubleBrace(); // does not affect the opened field
                this.#addPendingToken(this.#curToken);
                break;
            case PythonLexer.COLONEQUAL:
                this.#handleCOLONEQUALtokenInIString();
                break;
            case PythonLexer.ERRORTOKEN:
                this.#reportLexerError(`token recognition error at: '${this.#curToken.text}'`);
                this.#addPendingToken(this.#curToken);
                break;
            case Token.EOF:
                this.#handleEOFtoken();
                break;
            default:
                this.#addPendingToken(this.#curToken);
        }
        this.#handleFORMAT_SPECIFICATION_MODE();
    }

    #setCurrentAndLookAheadTokens() {
        this.#curToken = this.#laToken === null
                       ? super.nextToken()
                       : this.#laToken;

        this.#normalizeCurToken(); // Do not use laToken in this method or any of its submethods — it hasn't been set yet!

        this.#laToken = this.#curToken.type === Token.EOF
                      ? this.#curToken
                      : super.nextToken();

    }

    // - initialize indent stack
    // - skip BOM token
    // - insert ENCODING token (if any)
    // - hide leading NEWLINE(s)
    // - insert leading INDENT if first statement is indented

    #handleStartOfInput() {
        // - initialize indent stack with a default 0 indentation length
        // - skip BOM token
        // - insert ENCODING token (if any)
        // - hide leading NEWLINE(s)
        // - insert leading INDENT if first statement is indented        
        
        // The initial indentation length is never popped.
        this.#indentationLengthStack.push(0);

        if (this.#curToken.type === PythonLexer.BOM) {
            this.#setCurrentAndLookAheadTokens();
        }

        this.#insertENCODINGtoken();

        while (this.#curToken.type !== Token.EOF) {
            if (this.#curToken.channel === Token.DEFAULT_CHANNEL) {
                if (this.#curToken.type === PythonLexer.NEWLINE) {
                    // all the NEWLINE tokens must be ignored before the first statement
                    this.#hideAndAddPendingToken(this.#curToken);
                } else { // We're at the first statement
                    this.#insertLeadingIndentToken();
                    return; // continue the processing of the current token with #processCurrentToken()
                }
            } else {
                this.#addPendingToken(this.#curToken); // it can be WS, EXPLICIT_LINE_JOINING or COMMENT token
            }
            this.#setCurrentAndLookAheadTokens();
        } // continue the processing of the EOF token with #processCurrentToken()
    }

    #insertENCODINGtoken() {
        if (this.#sourceEncoding === "") return;

        const encodingToken = this.#curToken.clone();
        encodingToken.type = PythonLexer.ENCODING;
        encodingToken.channel = Token.HIDDEN_CHANNEL;
        encodingToken.start = 0;
        encodingToken.stop = 0;
        encodingToken.text = this.#sourceEncoding;
        encodingToken.line = 0;
        encodingToken.column = -1;
        this.#addPendingToken(encodingToken);
    }

    #insertLeadingIndentToken() {
        if (this.#previousPendingTokenType === PythonLexer.WS) {
            const prevToken = this.#pendingTokenQueue.at(-1); /* stack peek */ // WS token
            const length = this.#getIndentationLength(prevToken.text);
            if (length !== 0) { // there is an "indentation" before the first statement
                const errMsg = "first statement indented";
                this.#reportLexerError(errMsg);
                // insert an INDENT token before the first statement to trigger an 'unexpected indent' error later in the parser
                this.#createAndAddPendingToken(this.#curToken, PythonLexer.INDENT, PythonLexerBase.#ERR_TXT + errMsg);
            }
        }
    }

    // ===================== Indentation Handling =====================
    // Processes NEWLINE tokens, computes indentation length from leading
    // whitespace, manages the INDENT/DEDENT stack, emits the appropriate
    // indentation tokens, and detects inconsistent mixing of tabs and spaces

    #handleNEWLINEtoken() {
        if (this.#lexerModeStack.length > 0) { // for multi line f/t-string literals
            this.#addPendingToken(this.#curToken);
            return;
        }

        if (this.#openParenBracketBraceCount > 0) { // We're in an implicit line joining, ignore the current NEWLINE token
            this.#hideAndAddPendingToken(this.#curToken);
            return;
        }

        const nlToken = this.#curToken.clone(); // save the current NEWLINE token
        const isLookingAhead = this.#laToken.type === PythonLexer.WS;
        if (isLookingAhead) {
            this.#setCurrentAndLookAheadTokens(); // set the next two tokens
        }

        switch (this.#laToken.type) {
            case PythonLexer.NEWLINE: // We're before a blank line
            case PythonLexer.COMMENT: // We're before a comment
                this.#hideAndAddPendingToken(nlToken);
                if (isLookingAhead) {
                    this.#addPendingToken(this.#curToken); // WS token
                }
                break;
            default:
                this.#addPendingToken(nlToken);
                if (isLookingAhead) { // We're on a whitespace(s) followed by a statement
                    this.#addPendingToken(this.#curToken); // WS token
                    const indentationLength = this.#getIndentationLength(this.#curToken.text);
                    this.#insertIndentOrDedentToken(indentationLength); // may insert INDENT token or DEDENT token(s)
                } else { // We're at a newline followed by a statement (there is no whitespace before the statement)
                    this.#insertIndentOrDedentToken(0); // may insert DEDENT token(s)
                }
        }
    }

    #insertIndentOrDedentToken(curIndentLength) {
        let prevIndentLength = this.#indentationLengthStack.at(-1) /* stack peek */;
        if (curIndentLength > prevIndentLength) {
            this.#createAndAddPendingToken(this.#laToken, PythonLexer.INDENT, null);
            this.#indentationLengthStack.push(curIndentLength);
            return;
        }

        while (curIndentLength < prevIndentLength) { // more than 1 DEDENT token may be inserted to the token stream
            this.#indentationLengthStack.pop();
            prevIndentLength = this.#indentationLengthStack.at(-1) /* stack peek */;
            if (curIndentLength <= prevIndentLength) {
                this.#createAndAddPendingToken(this.#laToken, PythonLexer.DEDENT, null);
            } else {
                this.#reportError("inconsistent dedent");
            }
        }
    }

    #getIndentationLength(indentText) { // the indentText may contain spaces, tabs or form feeds
        let length = 0;
        if (this.#laToken.type !== PythonLexer.EOF) {
            for (const ch of indentText) {
                switch (ch) {
                    case ' ': // space
                        length++;
                        break;
                    case '\t':
                        length += PythonLexerBase.#TAB_LENGTH - (length % PythonLexerBase.#TAB_LENGTH);
                        break;
                    case '\f': // form feed
                        length = 0;
                        break;
                }
            }
        }
        return length;
    }

    // ===================== IString Processing =====================
    // Handles f- and t-string interpolation, including prefix detection,
    // ISTRING_MIDDLE token rewriting, escaped brace handling ({{ and }}),
    // quote+brace boundary cases, format-specifier mode transitions,
    // and brace-expression accumulation inside interpolated segments.

    #normalizeCurToken() {
        switch (this.#curToken.type) {
            case PythonLexer.FSTRING_START:
                this.#activeInterpolatedStringMiddleTokenType = PythonLexer.FSTRING_MIDDLE;
                this.#setLexerModeByISTRING_STARTtoken();
                return;
            case PythonLexer.TSTRING_START:
                this.#activeInterpolatedStringMiddleTokenType = PythonLexer.TSTRING_MIDDLE;
                this.#setLexerModeByISTRING_STARTtoken();
                return;
            case PythonLexer.FSTRING_MIDDLE:
            case PythonLexer.TSTRING_MIDDLE:
                this.#handleFSTRING_MIDDLEtokenWithQuoteAndLBrace(); // affect the opened field
                switch (this.#curToken.type) {
                    case PythonLexer.FSTRING_MIDDLE:
                    case PythonLexer.TSTRING_MIDDLE:
                        return; // No curToken exchange happened
                }
                break;
            case PythonLexer.FSTRING_END:
            case PythonLexer.TSTRING_END:
                this.#popLexerMode();
                return;
            default:
                if (this.#lexerModeStack.length === 0) {
                    return; // Not in fstring mode
                }

        }
        this.#processBraceExpression();
    }

    #processBraceExpression() {
        switch (this.#curToken.type) { // the following tokens can only come from default mode (after an LBRACE in f/t-string)
            case PythonLexer.NEWLINE:
                // append the current brace expression with the current newline
                this.#appendToBraceExpression(this.#curToken.text)
                this.#curToken.channel = Token.HIDDEN_CHANNEL;
                break;
            case PythonLexer.LBRACE:
                // the outermost brace expression cannot be a dictionary comprehension or a set comprehension
                this.#braceExpressionStack.push("{");
                this.#parenOrBracketOpenedStack.push(0);
                this.#pushLexerMode(Lexer.DEFAULT_MODE);
                break;
            case PythonLexer.LPAR:
            case PythonLexer.LSQB:
                // append the current brace expression with a "(" or a "["
                this.#appendToBraceExpression(this.#curToken.text)
                // https://peps.python.org/pep-0498/#lambdas-inside-expressions
                this.#incrementBraceDepth();
                break;
            case PythonLexer.RPAR:
            case PythonLexer.RSQB:
                // append the current brace expression with a ")" or a "]"
                this.#appendToBraceExpression(this.#curToken.text)
                this.#decrementBraceDepth();
                break;
            case PythonLexer.COLON:
            case PythonLexer.COLONEQUAL:
                // append the current brace expression with a ":" or a ":="
                this.#appendToBraceExpression(this.#curToken.text)
                this.#setLexerModeByCOLONorCOLONEQUALtoken();
                break;
            case PythonLexer.RBRACE:
                this.#setLexerModeAfterRBRACEtoken();
                break;
            default:
                // append the current brace expression with the current token text
                this.#appendToBraceExpression(this.#curToken.text)
        }
    }

    #appendToBraceExpression(text) {
        if (this.#braceExpressionStack.length === 0) throw new Error(`Cannot append to brace expression: stack is empty. (detected at line ${this.#curToken.line})`);

        const top = this.#braceExpressionStack.pop();
        this.#braceExpressionStack.push(top + text);
    }

    #incrementBraceDepth() { // increment the last element (stack peek + 1)
        if (this.#parenOrBracketOpenedStack.length === 0) throw new Error(`Cannot increment brace depth. (detected at line ${this.#curToken.line})`);

        const top = this.#parenOrBracketOpenedStack.pop();
        this.#parenOrBracketOpenedStack.push(top + 1);
    }

    #decrementBraceDepth() { // decrement the last element (stack peek - 1)
        if (this.#parenOrBracketOpenedStack.length === 0) throw new Error(`Cannot decrement brace depth: stack is empty. (detected at line ${this.#curToken.line})`);

        const top = this.#parenOrBracketOpenedStack.pop();
        if (top <= 0) throw new Error(`Cannot decrement brace depth: depth is already zero. (detected at line ${this.#curToken.line})`);

        this.#parenOrBracketOpenedStack.push(top - 1);
    }

    #setLexerModeAfterRBRACEtoken() {
        switch (this.#currentLexerMode) {
            case Lexer.DEFAULT_MODE:
                this.#popLexerMode();
                this.#popByBRACE();
                break;
            case PythonLexer.SQ1__FSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.SQ1__TSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.SQ1R_FSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.SQ1R_TSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.DQ1__FSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.DQ1__TSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.DQ1R_FSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.DQ1R_TSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.SQ3__FSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.SQ3__TSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.SQ3R_FSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.SQ3R_TSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.DQ3__FSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.DQ3__TSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.DQ3R_FSTRING_FORMAT_SPECIFICATION_MODE:
            case PythonLexer.DQ3R_TSTRING_FORMAT_SPECIFICATION_MODE:
                this.#popLexerMode();
                this.#popLexerMode();
                this.#popByBRACE();
                break;
            default:
                this.#reportLexerError("f-string: single '}' is not allowed");
        }
    }

    #setLexerModeByISTRING_STARTtoken() { // ISTRING = interpolated string (FSTRING or TSTRING)
        if (PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.size === 0) {
            PythonLexerBase.#initLexerModesForIStringStart();
        }

        const interpolatedStringPrefix = this.#curToken.text.toLowerCase();
        if (PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.has(interpolatedStringPrefix)) {
            const newLexerMode = PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.get(interpolatedStringPrefix);
            this.#pushLexerMode(newLexerMode);
        } else {
            this.#reportLexerError(
                "internal error: unknown interpolated string literal prefix: " + this.#curToken.text
            );
        }
    }

    static #initLexerModesForIStringStart() {
        // f-strings
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("f'", PythonLexer.SQ1__FSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("rf'", PythonLexer.SQ1R_FSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("fr'", PythonLexer.SQ1R_FSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("f\"", PythonLexer.DQ1__FSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("rf\"", PythonLexer.DQ1R_FSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("fr\"", PythonLexer.DQ1R_FSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("f'''", PythonLexer.SQ3__FSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("rf'''", PythonLexer.SQ3R_FSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("fr'''", PythonLexer.SQ3R_FSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("f\"\"\"", PythonLexer.DQ3__FSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("rf\"\"\"", PythonLexer.DQ3R_FSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("fr\"\"\"", PythonLexer.DQ3R_FSTRING_MODE);

        // t-strings
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("t'", PythonLexer.SQ1__TSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("rt'", PythonLexer.SQ1R_TSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("tr'", PythonLexer.SQ1R_TSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("t\"", PythonLexer.DQ1__TSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("rt\"", PythonLexer.DQ1R_TSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("tr\"", PythonLexer.DQ1R_TSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("t'''", PythonLexer.SQ3__TSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("rt'''", PythonLexer.SQ3R_TSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("tr'''", PythonLexer.SQ3R_TSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("t\"\"\"", PythonLexer.DQ3__TSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("rt\"\"\"", PythonLexer.DQ3R_TSTRING_MODE);
        PythonLexerBase.#LEXER_MODES_FOR_ISTRING_START.set("tr\"\"\"", PythonLexer.DQ3R_TSTRING_MODE);
    }

    #setLexerModeByCOLONorCOLONEQUALtoken() {
        if (this.#parenOrBracketOpenedStack.length <= 0) throw new Error(`Cannot peek brace depth: stack is empty. (detected at line ${this.#curToken.line})`);

        // Exit early when the current lexer mode indicates an open parenthesis/bracket
        const opened = this.#parenOrBracketOpenedStack.at(-1) > 0; /* stack peek */
        if (opened) return;

        if (this.#lexerModeStack.length <= 0) throw new Error(`Cannot peek lexer mode: stack is empty. (detected at line ${this.#curToken.line})`);

        // COLONEQUAL token will be replaced with a COLON token in processCurrentToken()
        const prevLexerMode = this.#lexerModeStack.at(-1); /* stack peek */
        switch (prevLexerMode) {
            case PythonLexer.SQ1__FSTRING_MODE:
            case PythonLexer.SQ1__FSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.SQ1__FSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.SQ1__TSTRING_MODE:
            case PythonLexer.SQ1__TSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.SQ1__TSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.SQ1R_FSTRING_MODE:
            case PythonLexer.SQ1R_FSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.SQ1R_FSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.SQ1R_TSTRING_MODE:
            case PythonLexer.SQ1R_TSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.SQ1R_TSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.DQ1__FSTRING_MODE:
            case PythonLexer.DQ1__FSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.DQ1__FSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.DQ1__TSTRING_MODE:
            case PythonLexer.DQ1__TSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.DQ1__TSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.DQ1R_FSTRING_MODE:
            case PythonLexer.DQ1R_FSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.DQ1R_FSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.DQ1R_TSTRING_MODE:
            case PythonLexer.DQ1R_TSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.DQ1R_TSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.SQ3__FSTRING_MODE:
            case PythonLexer.SQ3__FSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.SQ3__FSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.SQ3__TSTRING_MODE:
            case PythonLexer.SQ3__TSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.SQ3__TSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.SQ3R_FSTRING_MODE:
            case PythonLexer.SQ3R_FSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.SQ3R_FSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.SQ3R_TSTRING_MODE:
            case PythonLexer.SQ3R_TSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.SQ3R_TSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.DQ3__FSTRING_MODE:
            case PythonLexer.DQ3__FSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.DQ3__FSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.DQ3__TSTRING_MODE:
            case PythonLexer.DQ3__TSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.DQ3__TSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.DQ3R_FSTRING_MODE:
            case PythonLexer.DQ3R_FSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.DQ3R_FSTRING_FORMAT_SPECIFICATION_MODE);
                break;

            case PythonLexer.DQ3R_TSTRING_MODE:
            case PythonLexer.DQ3R_TSTRING_FORMAT_SPECIFICATION_MODE:
                this.#pushLexerMode(PythonLexer.DQ3R_TSTRING_FORMAT_SPECIFICATION_MODE);
                break;
        }
    }

    #popByBRACE() {
        if (this.#parenOrBracketOpenedStack.length <= 0) throw new Error(`Cannot pop brace depth: stack is empty. (detected at line ${this.#curToken.line})`);
        this.#parenOrBracketOpenedStack.pop();
        
        if (this.#braceExpressionStack.length <= 0) throw new Error(`Cannot pop brace expression: stack is empty. (detected at line ${this.#curToken.line})`);
        const parentBraceExpression = this.#braceExpressionStack.pop();

        this.#lastClosedBraceExpression = parentBraceExpression + "}";
        if (this.#braceExpressionStack.length > 0) {
            // Extend the current brace expression by adding the previous expression
            const parentBraceExpression = this.#braceExpressionStack.pop();
            this.#braceExpressionStack.push(parentBraceExpression + this.#lastClosedBraceExpression);
        }
    }

    #handleFSTRING_MIDDLEtokenWithDoubleBrace() { // ISTRING = interpolated string (FSTRING or TSTRING)
        // replace the trailing double brace with a single brace and insert a hidden brace token
        const lastTwoChars = this.#getLastTwoCharsOfTheCurTokenText();
        switch (lastTwoChars) {
            case "{{":
                this.#trimLastCharAddPendingTokenSetCurToken(PythonLexer.LBRACE, "{", Token.HIDDEN_CHANNEL);
                break;
            case "}}":
                this.#trimLastCharAddPendingTokenSetCurToken(PythonLexer.RBRACE, "}", Token.HIDDEN_CHANNEL);
                break;
        }
    }

    #handleFSTRING_MIDDLEtokenWithQuoteAndLBrace() { // ISTRING = interpolated string (FSTRING or TSTRING)
        // replace the trailing     quote + left_brace with a quote     and insert an LBRACE token
        // replace the trailing backslash + left_brace with a backslash and insert an LBRACE token        
        const lastTwoChars = this.#getLastTwoCharsOfTheCurTokenText();
        switch (lastTwoChars) {
            case "\"{":
            case "'{":
            case "\\{":
                this.#trimLastCharAddPendingTokenSetCurToken(PythonLexer.LBRACE, "{", Token.DEFAULT_CHANNEL);
                break;
        }
    }

    #getLastTwoCharsOfTheCurTokenText() {
        const text = this.#curToken.text;
        return text.length <= 2 ? text : text.slice(-2);
    }

    #trimLastCharAddPendingTokenSetCurToken(tokenType, tokenText, channel) {
        // trim the last char and add the modified curToken to the pendingTokenQueue
        const tokenTextWithoutLastChar = this.#curToken.text.slice(0, -1);
        this.#curToken.text = tokenTextWithoutLastChar;
        this.#curToken.stop -= 1;
        this.#addPendingToken(this.#curToken);

        this.#createNewCurrentTokenInstance(tokenType, tokenText, channel); // set curToken
    }

    #handleCOLONEQUALtokenInIString() { // ISTRING = interpolated string (FSTRING or TSTRING)
        if (this.#lexerModeStack.length > 0 &&
            this.#parenOrBracketOpenedStack.at(-1) === 0) { // stack peek === 0

            // In an f/t-string, the walrus operator (:=) is only allowed inside parentheses.
            // If used outside, split the COLONEQUAL token into a COLON
            // (used as a format specifier instead of a walrus operator),
            // and move the equal sign to the beginning of the next token (FSTRING_MIDDLE or TSTRING_MIDDLE).
            this.#curToken.type = PythonLexer.COLON;
            this.#curToken.text = ":";
            this.#curToken.stop = this.#curToken.start;

            switch (this.#laToken.type) {
                case PythonLexer.FSTRING_MIDDLE:
                case PythonLexer.TSTRING_MIDDLE: {
                    this.#laToken.text = "=" + this.#laToken.text;
                    this.#laToken.start -= 1;
                    this.#laToken.column -= 1;
                    break;
                }
                default: {
                    this.#addPendingToken(this.#curToken);
                    this.#createNewCurrentTokenInstance(this.#activeInterpolatedStringMiddleTokenType, "=", Token.DEFAULT_CHANNEL);
                }
            }
        }
        this.#addPendingToken(this.#curToken);
    }

    #createNewCurrentTokenInstance(tokenType, tokenText, channel) {
        const token = this.#curToken.clone();
        token.type = tokenType;
        token.text = tokenText;
        token.channel = channel;
        token.column += 1;
        token.start += 1;
        token.stop = token.start;
        this.#curToken = token;
    }

    // ===================== Lexer‑Mode Management =====================
    // Manages the custom lexer mode stack used for interpolated strings.
    // Provides controlled push/pop operations independent of ANTLR’s
    // internal mode stack to ensure correct behavior in complex IString flows.

    #pushLexerMode(mode) {
        this.pushMode(mode);
        this.#lexerModeStack.push(this.#currentLexerMode);
        this.#currentLexerMode = mode;
    }

    #popLexerMode() {
        if (this.#lexerModeStack.length <= 0) throw new Error(`Cannot pop lexer mode: stack is empty. (detected at line ${this.#curToken.line})`);

        this.popMode();
        this.#currentLexerMode = this.#lexerModeStack.pop();
    }

    // ===================== Format‑Specifier Handling =====================

    #handleFORMAT_SPECIFICATION_MODE() {
        if (this.#lexerModeStack.length == 0 || this.#laToken.type !== PythonLexer.RBRACE) {
            return;
        }

        // insert an empty FSTRING_MIDDLE or TSTRING_MIDDLE token instead of the missing format specification
        switch (this.#curToken.type) {
            case PythonLexer.COLON:
                this.#createAndAddPendingToken(this.#laToken, this.#activeInterpolatedStringMiddleTokenType, "");
                break;
            case PythonLexer.RBRACE:
                // only when the previous brace expression is not a dictionary comprehension or set comprehension
                if (!this.#isValid_DictionaryOrSet_ComprehensionExpression(this.#lastClosedBraceExpression)) {
                    this.#createAndAddPendingToken(this.#laToken, this.#activeInterpolatedStringMiddleTokenType, "");
                }
                break;
        }
    }

    // Determines whether the collected brace expression forms a dictionary or set
    // comprehension. Used to enforce Python’s rule that outermost f-string brace
    // expressions cannot be comprehensions.
    #isValid_DictionaryOrSet_ComprehensionExpression(code) {
        const inputStream = CharStreams.fromString(code);
        const lexer = new PythonLexer(inputStream);
        const tokenStream = new CommonTokenStream(lexer);
        let parser = new PythonParser(tokenStream);

        // Disable error listeners to suppress console output
        lexer.removeErrorListeners();
        parser.removeErrorListeners();

        parser.dictcomp(); // Try parsing as dictionary comprehension
        if (parser.syntaxErrorsCount === 0)
            return true;

        tokenStream.seek(0);
        parser = new PythonParser(tokenStream);
        parser.removeErrorListeners();
        parser.setcomp(); // Try parsing as set comprehension
        return parser.syntaxErrorsCount === 0;
    }

    // ===================== Trailing‑Token Finalization =====================
    // Handles end-of-input cleanup, including emission of remaining DEDENT tokens,
    // final NEWLINE normalization, and generation of the EOF token to properly
    // terminate the logical token stream.

    #insertTrailingTokens() {
        switch (this.#lastPendingTokenTypeFromDefaultChannel) {
            case PythonLexer.NEWLINE:
            case PythonLexer.DEDENT:
                break; // no trailing NEWLINE token is needed
            default:
                // insert an extra trailing NEWLINE token that serves as the end of the last statement
                this.#createAndAddPendingToken(this.#laToken, PythonLexer.NEWLINE, null); // laToken is EOF
        }
        this.#insertIndentOrDedentToken(0); // Now insert as much trailing DEDENT tokens as needed
    }

    #handleEOFtoken() {
        if (this.#lastPendingTokenTypeFromDefaultChannel > 0) {
            // there was a statement in the input (leading NEWLINE tokens are hidden)
            this.#insertTrailingTokens();
        }
        this.#addPendingToken(this.#curToken);
    }

    // ===================== Pending‑Token Management =====================
    // Manages the queue of pending tokens, including emission of normal and hidden
    // tokens, preserving correct output order for the token stream.

    #hideAndAddPendingToken(originalToken) {
        originalToken.channel = Token.HIDDEN_CHANNEL;
        this.#addPendingToken(originalToken);
    }

    #createAndAddPendingToken(originalToken, tokenType, tokenText) {
        const token = originalToken.clone();
        token.type = tokenType;
        token.channel = Token.DEFAULT_CHANNEL;
        token.stop = originalToken.start - 1;
        token.text = tokenText ?? `<${PythonLexer.symbolicNames.at(tokenType) ?? ""}>`;

        this.#addPendingToken(token);
    }

    #addPendingToken(token) {
        // save the last pending token type because the pendingTokenQueue can be empty by the nextToken()
        this.#previousPendingTokenType = token.type;
        if (token.channel === Token.DEFAULT_CHANNEL) {
            this.#lastPendingTokenTypeFromDefaultChannel = this.#previousPendingTokenType;
        }
        this.#pendingTokenQueue.push(token) /* .addLast(token) */;
    }

    // ===================== Error Reporting & Diagnostics =====================
    // Provides consistent lexer-level error reporting, including generation of
    // ERRORTOKEN instances, construction of human-readable diagnostic messages,
    // and insertion of error markers into the token stream to ensure that the
    // parser receives accurate context for recovery.

    #reportLexerError(errMsg) {
        this.getErrorListener().syntaxError(this, this.#curToken.type, this.#curToken.line, this.#curToken.column, " LEXER" + PythonLexerBase.#ERR_TXT + errMsg, null);
    }

    #reportError(errMsg) {
        this.#reportLexerError(errMsg);

        this.#createAndAddPendingToken(this.#laToken,PythonLexer.ERRORTOKEN, PythonLexerBase.#ERR_TXT + errMsg);
        // the ERRORTOKEN also triggers a parser error 
    }
}
