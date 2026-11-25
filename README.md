# ANTLR4 parser for Python 3.15.2 &nbsp; [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

### About files:
 - PythonParser.g4 is the ANTLR4 parser grammar that based on the official [Python PEG grammar](https://docs.python.org/3.15/reference/grammar.html)

 - PythonLexerBase class
    - handles the Python indentations
    - creates encoding token
    - tokenizes f-string, t-string literals

### Recent changes:
- parser grammar update for Python 3.15.2
- removed inconsistent tabs and spaces checking in indentations

### Tokenization Compatibility:
The lexer was tested against the complete source code of the [Python Standard Lib](https://github.com/python/cpython/tree/main/Lib) directory. After some conversion required, the token text list generated from all source files was compared with the token text list produced by Python's tokenizer ([tokenize.py](https://github.com/python/cpython/blob/main/Lib/tokenize.py)).
The two lists matched 100%. Naturally, this does not rule out the possibility that the lexer may still contain bugs.

### Limitations:
This lexer/parser is not intended to detect and report all syntax errors in the Python source code being analyzed.
The lexer and parser handle erroneous input only to the extent necessary for parsing. Therefore, when processing syntactically invalid source code, the lexer/parser does not guarantee that all errors will be detected or reported.
For reliable analysis, it is recommended to verify before running the lexer/parser that the source code conforms to the Python language rules, for example by using the appropriate version of the Python interpreter.

### Related links:
[ANTLR 4](https://www.antlr.org/)

[ANTLR4-tools](https://github.com/antlr/antlr4/blob/master/doc/getting-started.md#getting-started-the-easy-way-using-antlr4-tools)

[ANTLR 4 Documentation](https://github.com/antlr/antlr4/tree/master/doc)

[ANTLR 4 Runtime API](https://www.antlr.org/api/Java/)

[Python 3.15 Lexical Analysis](https://docs.python.org/3.15/reference/lexical_analysis.html)

[cpython](https://github.com/python/cpython)

[ANTLR4 parser for Python 2.7.18](https://github.com/RobEin/ANTLR4-parser-for-Python-2.7.18)

[ANTLR4 parser for Python 3.8](https://github.com/RobEin/ANTLR4-parser-for-Python-3.8.12)
