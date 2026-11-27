using Antlr4.Runtime;
using System.Text;
using System.Text.RegularExpressions;

/// <summary>
/// GRUN (Grammar Unit Test) for Python
/// </summary>
public static class Grun4py
{
    private static readonly string DEFAULT_ENCODING = PythonLexer.DEFAULT_ENCODING; // Python 2: ASCII, Python 3: utf-8
    private static readonly byte[] UTF8_BOM = [0xEF, 0xBB, 0xBF];
    private static readonly byte[] UTF32_BE_BOM = [0x00, 0x00, 0xFE, 0xFF];
    private static readonly byte[] UTF32_LE_BOM = [0xFF, 0xFE, 0x00, 0x00];
    private static readonly byte[] UTF16_BE_BOM = [0xFE, 0xFF];
    private static readonly byte[] UTF16_LE_BOM = [0xFF, 0xFE];
    private const int MAX_BOM_LENGTH = 4;

    private const byte MAX_ASCII = 0x7f;

    private static readonly Regex ENCODING_PATTERN =
        new(@"^[ \t\f]*#.*?coding[:=][ \t]*([-_.a-zA-Z0-9]+)", RegexOptions.Compiled);

    private static readonly Regex COMMENT_PATTERN =
        new(@"^[ \t\f]*(#.*)?$", RegexOptions.Compiled);

    private static readonly Dictionary<string, string> ENCODING_MAP = new()
    {
        // UTF-8
        { "utf8sig", "utf-8" },
        { "utf8", "utf-8" },
        { "utf", "utf-8" },
        // UTF-16 LE
        { "utf16le", "utf-16LE" },
        { "utf16", "utf-16LE" },
        { "ucs2", "utf-16LE" },
        { "ucs2le", "utf-16LE" },
        // ISO-8859-1 / Latin-1
        { "latin1", "iso-8859-1" },
        { "latin", "iso-8859-1" },
        { "iso88591", "iso-8859-1" },
        { "iso8859", "iso-8859-1" },
        { "cp819", "iso-8859-1" },
        // ASCII
        { "ascii", "us-ascii" },
        { "usascii", "us-ascii" },
        { "ansix341968", "us-ascii" },
        { "cp367", "us-ascii" },
        // Deprecated alias
        { "binary", "iso-8859-1" },
    };

    public static int Main(string[] args)
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance); // Enable support for legacy code-page encodings (e.g. KOI8-R)

        if (args.Length < 1)
        {
            Console.WriteLine(
                "\n" +
                "------------------------------\n" +
                "USAGE:\n" +
                "grun4py.exe filename.py\n" +
                "or\n" +
                "dotnet run filename.py\n" +
                "\n" +
                "------------------------------\n" +
                "TOKEN OUTPUT FORMAT:\n" +
                "[@TokenIndex,StartIndex:StopIndex='TokenText',<TokenName>,Channel,Line:Column]\n" +
                "Channel is optional. Lines are 1-based; columns are 0-based.\n" +
                "\n" +
                "------------------------------"
            );
            return 1;
        }

        string filePath = args[0];

        try
        {
            var sourceEncoding = DetectEncoding(filePath);
            var text = ReadFileWithEncoding(filePath, sourceEncoding);
            var input = CharStreams.fromString(text);

            PythonLexer lexer = new(input);
            lexer.SetEncoding(sourceEncoding); // generate ENCODING token

            CommonTokenStream tokens = new(lexer);
            PythonParser parser = new(tokens);

            tokens.Fill();
            foreach (IToken token in tokens.GetTokens())
            {
                Console.WriteLine(FormatToken(token));
            }

            parser.file_input();
            return parser.NumberOfSyntaxErrors;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("Error: " + ex.Message);
            Console.Error.WriteLine(ex.StackTrace);
            return 1;
        }
    }

    private static string ReadFileWithEncoding(string filePath, string sourceEncoding)
    {
        // IMPORTANT: Decode the file using the detected source encoding before
        // creating the ANTLR CharStream. This ensures that encoding errors are
        // detected before lexical analysis and that the lexer receives decoded text.

        try
        {
            var sourceTextEncoding = Encoding.GetEncoding(sourceEncoding
                                                        , EncoderFallback.ExceptionFallback
                                                        , DecoderFallback.ExceptionFallback);

            var bytes = File.ReadAllBytes(filePath);
            return sourceTextEncoding.GetString(bytes);
        }
        catch (Exception ex) when (ex is ArgumentException || ex is DecoderFallbackException)
        {
            throw new IOException($"Failed to decode file with encoding '{sourceEncoding}': {ex.Message}"
                                , ex);

        }
    }

    // ---------- Token formatting ----------

    private static string FormatToken(IToken token)
    {
        var tokenText = EscapeSpecialChars(token.Text);
        var tokenName = token.Type == TokenConstants.EOF
            ? "EOF"
            : PythonLexer.DefaultVocabulary.GetSymbolicName(token.Type);

        var channelName = token.Channel == TokenConstants.DefaultChannel
			? ""
			: $"channel={PythonLexer.channelNames[token.Channel]},";

        return $"[@{token.TokenIndex},{token.StartIndex}:{token.StopIndex}='{tokenText}',<{tokenName}>,{channelName}{token.Line}:{token.Column}]";
    }

    private static string EscapeSpecialChars(string text)
    {
        return text
            .Replace("\n", "\\n")
            .Replace("\r", "\\r")
            .Replace("\t", "\\t")
            .Replace("\f", "\\f");
    }

    // ---------- Encoding detection ----------

    private static string DetectEncoding(string filePath)
    {
        bool hasUTF8BOM = DetectBOM(filePath);
        string commentEncoding = DetectEncodingFromComments(filePath, hasUTF8BOM);
        return ResolveFinalEncoding(filePath, hasUTF8BOM, commentEncoding);
    }

    private static bool DetectBOM(string filePath)
    {
        byte[] buffer = new byte[MAX_BOM_LENGTH];
        using FileStream stream = File.OpenRead(filePath);
        int bytesRead = stream.Read(buffer, 0, MAX_BOM_LENGTH);

        if (BufferStartsWith(buffer, bytesRead, UTF8_BOM)) return true;
        if (BufferStartsWith(buffer, bytesRead, UTF32_BE_BOM)) throw BomError(filePath, "UTF-32 BE BOM");
        if (BufferStartsWith(buffer, bytesRead, UTF32_LE_BOM)) throw BomError(filePath, "UTF-32 LE BOM");
        if (BufferStartsWith(buffer, bytesRead, UTF16_BE_BOM)) throw BomError(filePath, "UTF-16 BE BOM");
        if (BufferStartsWith(buffer, bytesRead, UTF16_LE_BOM)) throw BomError(filePath, "UTF-16 LE BOM");
        return false;
    }

    private static bool BufferStartsWith(byte[] buffer, int bytesRead, byte[] bom)
    {
        if (bytesRead < bom.Length) return false; // Not enough bytes to match this BOM

        for (int i = 0; i < bom.Length; i++)
        {
            if (buffer[i] != bom[i])
                return false;
        }
        return true;
    }

    private static IOException BomError(string filePath, string msg)
    {
        return new IOException($"Invalid BOM encoding for '{Path.GetFileName(filePath)}': {msg}");
    }

    private static string DetectEncodingFromComments(string filePath, bool hasUTF8BOM)
    {
        using FileStream stream = File.OpenRead(filePath);
        if (hasUTF8BOM) stream.Seek(UTF8_BOM.Length, SeekOrigin.Begin);

        for (int i = 0; i < 2; i++)
        {
            string? line = ReadAsciiLine(stream);
            if (line == null) return "";

            if (COMMENT_PATTERN.IsMatch(line))
            {
                string enc = ExtractEncodingFromLine(line);
                if (!string.IsNullOrEmpty(enc))
                {
                    return enc; // encoding found in comment
                }
            }
            else
            {
                break; // statement or backslash found (the line is not blank, not whitespace(s), not comment)
            }
        }
        return "";
    }

    private static string? ReadAsciiLine(FileStream stream)
    {
        StringBuilder lineBuilder = new();
        int ascii;
        while ((ascii = stream.ReadByte()) != -1)
        {
            if (ascii > MAX_ASCII) return null;
            if (ascii == '\n') break;
            if (ascii != '\r') lineBuilder.Append((char)ascii);
        }
        return lineBuilder.ToString();
    }

    private static string ExtractEncodingFromLine(string line)
    {
        Match m = ENCODING_PATTERN.Match(line);
        if (!m.Success) return "";
        return NormalizeEncoding(m.Groups[1].Value);
    }

    private static string NormalizeEncoding(string enc)
    {
        if (string.IsNullOrEmpty(enc)) return enc;

        string normalized = enc
            .ToLowerInvariant()
            .Replace("_", "")
            .Replace("-", "")
            .Replace(" ", "");

        if (normalized.EndsWith("codec", StringComparison.Ordinal))
        {
            normalized = normalized[..^5];
        }

        return ENCODING_MAP.TryGetValue(normalized, out var value)
             ? value
             : enc;
    }

    private static string ResolveFinalEncoding(string filePath,
                                               bool hasUTF8_BOM,
                                               string commentEncoding)
    {
        bool hasConflict = !string.IsNullOrEmpty(commentEncoding)
                           && hasUTF8_BOM
                           && !IsUTF8(commentEncoding);
        if (hasConflict)
        {
            throw new IOException($"Encoding conflict for '{Path.GetFileName(filePath)}': " + $"UTF-8 BOM and encoding declaration '{commentEncoding}'");
        }
        return string.IsNullOrEmpty(commentEncoding) ? Grun4py.DEFAULT_ENCODING : commentEncoding;
    }

    private static bool IsUTF8(string enc)
    {
        return enc
                .Replace("-", "")
                .Replace("_", "")
                .Equals("utf8", StringComparison.OrdinalIgnoreCase);
    }
}
