// SQL parser. User SQL is Oracle SQL (.claude/docs/SQL_DIALECT.md): Parser.Oracle = true (ParseScript, views) rejects
// non-Oracle syntax with a hint. SQL the engine builds for itself is parsed lenient (Oracle = false): every Oracle form
// plus the older grammar it uses internally (LIMIT, TRY_CAST, ::, * EXCLUDE, t AS a(cols), FILTER, [names] ...).
// Oracle forms: OFFSET n ROWS FETCH FIRST n ROWS ONLY, ROWNUM, DUAL, MINUS, DECODE / NVL / NVL2, LISTAGG and
// PERCENTILE_* WITHIN GROUP, CAST ... DEFAULT ... ON CONVERSION ERROR, INTERVAL literals, q'[...]', TRIM(... FROM ...),
// LIKE ... ESCAPE, SYSDATE / SYSTIMESTAMP, '' = NULL. Statements (INSERT, UPDATE, CREATE, PL/SQL ...) are in Script.cs.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace NativeDataEngine
{
    // ---------- syntax tree ----------
    public abstract class Expr
    {
        public abstract string Key();   // canonical text: used to match GROUP BY expressions in the select list
        public override string ToString() { return Key(); }
    }
    public sealed class ColName : Expr
    {
        public string Table, Name;
        public override string Key() { return (Table != null ? Table.ToLowerInvariant() + "." : "") + "\"" + Name.ToLowerInvariant() + "\""; }
    }
    public sealed class Lit : Expr
    {
        public object Value; public DataType Type;
        public override string Key() { return "lit:" + Type.Name + ":" + Values.ToText(Value, Type); }
    }
    public sealed class WindowSpec
    {
        public List<Expr> Partition = new List<Expr>();
        public List<OrderItem> Order = new List<OrderItem>();
        public string Key()
        {
            StringBuilder sb = new StringBuilder("over(");
            foreach (Expr e in Partition) sb.Append(e.Key()).Append(',');
            sb.Append('|');
            foreach (OrderItem o in Order) sb.Append(o.Key()).Append(',');
            return sb.Append(')').ToString();
        }
    }
    public sealed class Call : Expr
    {
        public string Name; public List<Expr> Args = new List<Expr>(); public bool Distinct, Star;
        public Expr Filter; public WindowSpec Over;
        public List<OrderItem> WithinOrder;   // LISTAGG(...) WITHIN GROUP (ORDER BY ...)
        public override string Key()
        {
            StringBuilder sb = new StringBuilder(Name.ToLowerInvariant()).Append('(');
            if (Distinct) sb.Append("distinct ");
            if (Star) sb.Append('*');
            for (int i = 0; i < Args.Count; i++) { if (i > 0) sb.Append(','); sb.Append(Args[i].Key()); }
            sb.Append(')');
            if (WithinOrder != null) { sb.Append(" within("); foreach (OrderItem o in WithinOrder) sb.Append(o.Key()).Append(','); sb.Append(')'); }
            if (Filter != null) sb.Append(" filter(").Append(Filter.Key()).Append(')');
            if (Over != null) sb.Append(Over.Key());
            return sb.ToString();
        }
    }
    public sealed class BinOp : Expr
    {
        public string Op; public Expr L, R;
        public override string Key() { return "(" + L.Key() + " " + Op + " " + R.Key() + ")"; }
    }
    public sealed class UnOp : Expr
    {
        public string Op; public Expr X;
        public override string Key() { return "(" + Op + " " + X.Key() + ")"; }
    }
    public sealed class IsNullE : Expr
    {
        public Expr X; public bool Not;
        public override string Key() { return "(" + X.Key() + (Not ? " is not null)" : " is null)"); }
    }
    public sealed class InE : Expr
    {
        public Expr X; public List<Expr> List = new List<Expr>(); public bool Not;
        public override string Key() { StringBuilder sb = new StringBuilder("(" + X.Key() + (Not ? " not in (" : " in (")); foreach (Expr e in List) sb.Append(e.Key()).Append(','); return sb.Append("))").ToString(); }
    }
    public sealed class BetweenE : Expr
    {
        public Expr X, Lo, Hi; public bool Not;
        public override string Key() { return "(" + X.Key() + (Not ? " not between " : " between ") + Lo.Key() + " and " + Hi.Key() + ")"; }
    }
    public sealed class LikeE : Expr
    {
        public Expr X, Pat; public bool Not, Insensitive; public char Escape;   // Escape: LIKE ... ESCAPE 'c' (0 = none)
        public override string Key() { return "(" + X.Key() + (Not ? " not" : "") + (Insensitive ? " ilike " : " like ") + Pat.Key() + (Escape != 0 ? " escape " + Escape : "") + ")"; }
    }
    public sealed class CaseE : Expr
    {
        public Expr Operand; public List<Expr> Whens = new List<Expr>(), Thens = new List<Expr>(); public Expr Else;
        public override string Key()
        {
            StringBuilder sb = new StringBuilder("case ");
            if (Operand != null) sb.Append(Operand.Key());
            for (int i = 0; i < Whens.Count; i++) sb.Append(" when ").Append(Whens[i].Key()).Append(" then ").Append(Thens[i].Key());
            if (Else != null) sb.Append(" else ").Append(Else.Key());
            return sb.Append(" end").ToString();
        }
    }
    public sealed class CastE : Expr
    {
        public Expr X; public DataType T; public bool Try;
        public override string Key() { return (Try ? "try_cast(" : "cast(") + X.Key() + " as " + T.Name + ")"; }
    }
    public sealed class RowE : Expr
    {
        public List<Expr> Items = new List<Expr>();
        public override string Key() { StringBuilder sb = new StringBuilder("row("); foreach (Expr e in Items) sb.Append(e.Key()).Append(','); return sb.Append(')').ToString(); }
    }
    public sealed class ListE : Expr
    {
        public List<Expr> Items = new List<Expr>();
        public override string Key() { StringBuilder sb = new StringBuilder("["); foreach (Expr e in Items) sb.Append(e.Key()).Append(','); return sb.Append(']').ToString(); }
    }
    public sealed class StarE : Expr
    {
        public string Table; public List<string> Exclude = new List<string>();
        public override string Key() { return (Table != null ? Table + "." : "") + "*"; }
    }
    // Oracle ROWNUM: WHERE ROWNUM <= n becomes a row limit (applied before ORDER BY), ROWNUM in the select list a row number.
    public sealed class RownumE : Expr { public override string Key() { return "rownum"; } }
    // INTERVAL 'n' unit: days (DAY / HOUR / MINUTE / SECOND, as a fraction of a day) or months (MONTH / YEAR).
    public sealed class IntervalE : Expr
    {
        public bool IsMonths; public long Months; public object Days;   // Days: long (whole days) or double
        public override string Key() { return "interval:" + (IsMonths ? Months + "m" : Convert.ToString(Days, CultureInfo.InvariantCulture) + "d"); }
    }
    // Subqueries in expressions (planned by Planner.Unnest as joins).
    public abstract class SubE : Expr
    {
        static int seq; public readonly int Id = System.Threading.Interlocked.Increment(ref seq);
        public QueryStmt Q;
    }
    public sealed class SubqueryE : SubE { public override string Key() { return "subq#" + Id; } }
    public sealed class ExistsE : SubE { public override string Key() { return "exists#" + Id; } }
    public sealed class InSubE : SubE { public Expr X; public bool Not; public override string Key() { return "insub#" + Id; } }
    public sealed class QuantE : SubE { public Expr X; public string Op; public bool All; public override string Key() { return "quant#" + Id; } }
    // GROUP BY GROUPING SETS ((a, b), (a), ())
    public sealed class GroupingSetsE : Expr
    {
        public List<List<Expr>> Sets = new List<List<Expr>>();
        public override string Key() { StringBuilder sb = new StringBuilder("sets("); foreach (List<Expr> l in Sets) { sb.Append('('); foreach (Expr e in l) sb.Append(e.Key()).Append(','); sb.Append(')'); } return sb.Append(')').ToString(); }
    }
    public sealed class OrderItem
    {
        public Expr E; public bool Desc; public int Nulls; // 0 default (NULLS LAST), 1 first, 2 last
        public string Key() { return E.Key() + (Desc ? " desc" : "") + (Nulls == 1 ? " nf" : ""); }
    }
    public sealed class SelectItem { public Expr E; public string Alias; }

    public abstract class TableRef { public string Alias; public List<string> ColAliases; public bool Hidden; }   // Hidden: columns left out of *
    public sealed class NamedTable : TableRef { public string Name; }
    public sealed class SubqueryTable : TableRef { public QueryStmt Query; }
    public sealed class FuncTable : TableRef
    {
        public string Name; public List<Expr> Args = new List<Expr>();
        public Dictionary<string, Expr> Named = new Dictionary<string, Expr>(StringComparer.OrdinalIgnoreCase);
    }
    // src PIVOT (agg(x) FOR col IN (v1 [AS a1], ...))
    public sealed class PivotRef : TableRef
    {
        public TableRef Source; public Call Agg; public Expr For; public List<Expr> Values = new List<Expr>(); public List<string> ValueAliases = new List<string>();
    }
    public sealed class JoinRef : TableRef
    {
        public TableRef Left, Right; public string Kind = "INNER"; public Expr On; public List<string> Using;
    }

    public sealed class SelectStmt
    {
        public bool Distinct; public List<SelectItem> Items = new List<SelectItem>();
        public TableRef From; public Expr Where; public List<Expr> GroupBy = new List<Expr>(); public bool GroupAll; public Expr Having;
        public string Into;   // SELECT ... INTO table (scripts)
        public SelectStmt Clone()
        {
            SelectStmt c = new SelectStmt(); c.Distinct = Distinct; c.From = From; c.Where = Where; c.GroupBy = new List<Expr>(GroupBy); c.GroupAll = GroupAll; c.Having = Having; c.Into = Into;
            foreach (SelectItem it in Items) { SelectItem n = new SelectItem(); n.E = it.E; n.Alias = it.Alias; c.Items.Add(n); }
            return c;
        }
    }
    // VALUES (a, b), (c, d): constant rows.
    public sealed class ValuesBody { public List<List<Expr>> Rows = new List<List<Expr>>(); }
    public sealed class SetOp { public object Left, Right; public string Op; public bool All; }   // Left/Right: SelectStmt, SetOp or QueryStmt
    public sealed class QueryStmt
    {
        public List<KeyValuePair<string, QueryStmt>> With = new List<KeyValuePair<string, QueryStmt>>();
        public object Body;   // SelectStmt, SetOp, QueryStmt or ValuesBody
        public List<OrderItem> Order = new List<OrderItem>(); public bool OrderAll; public bool OrderAllDesc;
        public long Limit = -1; public long Offset = 0;
        public bool Describe;
        public List<string> Cols;   // WITH name(a, b) AS (...): column names of a CTE
        public QueryStmt Copy() { QueryStmt c = new QueryStmt(); c.With = With; c.Body = Body; c.Order = Order; c.OrderAll = OrderAll; c.OrderAllDesc = OrderAllDesc; c.Limit = Limit; c.Offset = Offset; c.Describe = Describe; c.Cols = Cols; return c; }
    }

    // ---------- lexer ----------
    public enum Tk { Ident, QIdent, Str, Num, Op, End }
    public sealed class Token
    {
        public Tk T; public string V; public int Pos;
        public override string ToString() { return T == Tk.End ? "end of query" : "'" + V + "'"; }
    }

    public static class Lexer
    {
        public static List<Token> Run(string s) { return Run(s, false); }
        // oracle: `name` and [name] quoting are errors / not names (Oracle quotes names with "...").
        public static List<Token> Run(string s, bool oracle)
        {
            List<Token> r = new List<Token>();
            int i = 0, n = s.Length;
            while (i < n)
            {
                char c = s[i];
                if (char.IsWhiteSpace(c)) { i++; continue; }
                if (c == '-' && i + 1 < n && s[i + 1] == '-') { while (i < n && s[i] != '\n') i++; continue; }
                if (c == '/' && i + 1 < n && s[i + 1] == '*') { int e = s.IndexOf("*/", i + 2, StringComparison.Ordinal); i = e < 0 ? n : e + 2; continue; }
                Token t = new Token(); t.Pos = i;
                // Oracle text literals: N'...', q'[...]' (delimiters [] {} () <> or any repeated character), Nq'...'.
                int qs = (c == 'n' || c == 'N') && i + 1 < n && s[i + 1] == '\'' ? i + 1
                    : (c == 'q' || c == 'Q') && i + 2 < n && s[i + 1] == '\'' ? i
                    : (c == 'n' || c == 'N') && i + 3 < n && (s[i + 1] == 'q' || s[i + 1] == 'Q') && s[i + 2] == '\'' ? i + 1 : -1;
                if (qs >= 0 && (i == 0 || !(char.IsLetterOrDigit(s[i - 1]) || s[i - 1] == '_')))
                {
                    if (s[qs] == '\'') { i = qs; c = '\''; }
                    else
                    {
                        char open = s[qs + 2], close = open == '[' ? ']' : open == '{' ? '}' : open == '(' ? ')' : open == '<' ? '>' : open;
                        int e = qs + 3;
                        while (e + 1 < n && !(s[e] == close && s[e + 1] == '\'')) e++;
                        if (e + 1 >= n) throw Err("Unterminated q'...' text", t.Pos);
                        t.T = Tk.Str; t.V = s.Substring(qs + 3, e - qs - 3); i = e + 2; r.Add(t); continue;
                    }
                }
                if (oracle && c == '`') throw Err("`name` quoting is not Oracle SQL: use \"name\"", i);
                if (char.IsLetter(c) || c == '_' || (c == '#' && i + 1 < n && (char.IsLetter(s[i + 1]) || s[i + 1] == '_' || s[i + 1] == '#')))
                {
                    int st = i; i++; while (i < n && (char.IsLetterOrDigit(s[i]) || s[i] == '_' || s[i] == '$' || s[i] == '#')) i++;
                    t.T = Tk.Ident; t.V = s.Substring(st, i - st);
                }
                else if (c == '"' || c == '`')
                {
                    char q = c; StringBuilder sb = new StringBuilder(); i++;
                    while (true)
                    {
                        if (i >= n) throw Err("Unterminated quoted name", t.Pos);
                        if (s[i] == q) { if (i + 1 < n && s[i + 1] == q) { sb.Append(q); i += 2; continue; } i++; break; }
                        sb.Append(s[i++]);
                    }
                    t.T = Tk.QIdent; t.V = sb.ToString();
                }
                else if (c == '[' && !oracle && BracketName(s, i) != null)
                {
                    // [name] (SQL Server quoting): a bracket with no comma or quote inside; [1, 2] / ['a'] stay lists.
                    string nm = BracketName(s, i); i += nm.Length + 2; t.T = Tk.QIdent; t.V = nm;
                }
                else if (c == '\'')
                {
                    StringBuilder sb = new StringBuilder(); i++;
                    while (true)
                    {
                        if (i >= n) throw Err("Unterminated string", t.Pos);
                        if (s[i] == '\'') { if (i + 1 < n && s[i + 1] == '\'') { sb.Append('\''); i += 2; continue; } i++; break; }
                        sb.Append(s[i++]);
                    }
                    t.T = Tk.Str; t.V = sb.ToString();
                }
                else if (char.IsDigit(c) || (c == '.' && i + 1 < n && char.IsDigit(s[i + 1])))
                {
                    int st = i;
                    while (i < n && (char.IsDigit(s[i]) || s[i] == '_')) i++;
                    if (i < n && s[i] == '.' && !(i + 1 < n && s[i + 1] == '.')) { i++; while (i < n && char.IsDigit(s[i])) i++; }
                    if (i < n && (s[i] == 'e' || s[i] == 'E') && i + 1 < n && (char.IsDigit(s[i + 1]) || ((s[i + 1] == '-' || s[i + 1] == '+') && i + 2 < n && char.IsDigit(s[i + 2]))))
                    { i += 2; while (i < n && char.IsDigit(s[i])) i++; }
                    t.T = Tk.Num; t.V = s.Substring(st, i - st).Replace("_", "");
                }
                else
                {
                    string two = i + 1 < n ? s.Substring(i, 2) : null;
                    if (two == "<>" || two == "!=" || two == "<=" || two == ">=" || two == "||" || two == "::" || two == "//" || two == "==" || two == ":=") { t.V = two; i += 2; }
                    else if (two == "^=") { t.V = "<>"; i += 2; }   // Oracle not-equal
                    else if ("=<>+-*/%(),.;[]{}:".IndexOf(c) >= 0) { t.V = c.ToString(); i++; }
                    else throw Err("Unexpected character '" + c + "'", i);
                    t.T = Tk.Op;
                }
                r.Add(t);
            }
            Token end = new Token(); end.T = Tk.End; end.V = ""; end.Pos = n; r.Add(end);
            return r;
        }
        public static EngineException Err(string m, int pos) { return new EngineException("SQL_SYNTAX", m + " at position " + (pos + 1) + "."); }
        static string BracketName(string s, int i)
        {
            int e = s.IndexOf(']', i + 1);
            if (e <= i + 1) return null;
            string inner = s.Substring(i + 1, e - i - 1);
            if (inner.Trim().Length == 0 || inner.IndexOfAny(new[] { ',', '\'', '"', '[', '\n', '\r' }) >= 0) return null;
            return inner;
        }
    }

    // ---------- parser ----------
    public sealed partial class Parser
    {
        private readonly List<Token> t;
        private readonly string src;
        private int p;
        private static readonly HashSet<string> Reserved = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "SELECT","FROM","WHERE","GROUP","BY","HAVING","ORDER","LIMIT","OFFSET","UNION","EXCEPT","INTERSECT","JOIN","INNER","LEFT","RIGHT",
            "FULL","OUTER","CROSS","ON","USING","AS","AND","OR","NOT","IN","IS","NULL","BETWEEN","LIKE","ILIKE","CASE","WHEN","THEN","ELSE",
            "END","ASC","DESC","WITH","DISTINCT","ALL","FILTER","OVER","PARTITION","NULLS","WINDOW","QUALIFY","NATURAL","EXCLUDE","LATERAL",
            "PIVOT","UNPIVOT","INTO","VALUES","SET","INSERT","UPDATE","DELETE","CREATE","DROP","ALTER","TRUNCATE","MERGE","COMMIT","ROLLBACK",
            "THROW","RAISERROR","GO","PRINT","WHEN","MATCHED","RETURNING","MINUS","FETCH","WITHIN","KEEP","EXCEPTION" };

        // Oracle: user SQL, only Oracle syntax accepted (see the file header).
        public readonly bool Oracle;
        public Parser(string sql) : this(sql, false) { }
        public Parser(string sql, bool oracle) { src = sql ?? ""; Oracle = oracle; t = Lexer.Run(src, oracle); p = 0; }
        EngineException NotOra(string what, string use) { return Err(what + " is not Oracle SQL" + (use != null ? ": use " + use : "")); }

        public static QueryStmt ParseQuery(string sql) { return ParseQuery(sql, false); }
        public static QueryStmt ParseQuery(string sql, bool oracle)
        {
            Parser ps = new Parser(sql, oracle);
            QueryStmt q;
            if (ps.IsKw("DESCRIBE")) { ps.p++; q = ps.Query(); q.Describe = true; }
            else q = ps.Query();
            while (ps.IsOp(";")) ps.p++;
            if (ps.Cur.T != Tk.End) throw ps.Err("Unexpected " + ps.Cur);
            return q;
        }

        private Token Cur { get { return t[p]; } }
        private Token Peek(int k) { return t[Math.Min(p + k, t.Count - 1)]; }
        private EngineException Err(string m) { return Lexer.Err(m, Cur.Pos); }
        private bool IsKw(string k) { return Cur.T == Tk.Ident && string.Equals(Cur.V, k, StringComparison.OrdinalIgnoreCase); }
        private bool IsKwAt(int k, string kw) { Token x = Peek(k); return x.T == Tk.Ident && string.Equals(x.V, kw, StringComparison.OrdinalIgnoreCase); }
        private bool IsOp(string o) { return Cur.T == Tk.Op && Cur.V == o; }
        private bool Accept(string kw) { if (IsKw(kw)) { p++; return true; } return false; }
        private bool AcceptOp(string o) { if (IsOp(o)) { p++; return true; } return false; }
        private void Expect(string kw) { if (!Accept(kw)) throw Err("Expected " + kw + " but found " + Cur); }
        private void ExpectOp(string o) { if (!AcceptOp(o)) throw Err("Expected '" + o + "' but found " + Cur); }

        private string Name()
        {
            if (Cur.T == Tk.QIdent) return t[p++].V;
            if (Cur.T == Tk.Ident) return t[p++].V;
            throw Err("Expected a name but found " + Cur);
        }

        public QueryStmt Query()
        {
            QueryStmt q = new QueryStmt();
            if (Accept("WITH"))
            {
                if (Oracle && IsKw("RECURSIVE")) throw NotOra("WITH RECURSIVE", "WITH name (columns) AS (...), which is recursive when it names itself");
                Accept("RECURSIVE");
                do
                {
                    string name = Name();
                    List<string> cols = null;
                    if (IsOp("(")) { p++; cols = new List<string>(); do { cols.Add(Name()); } while (AcceptOp(",")); ExpectOp(")"); }   // name(a, b) AS (...)
                    Expect("AS");
                    if (Oracle && (IsKw("MATERIALIZED") || IsKw("NOT"))) throw NotOra("MATERIALIZED", null);
                    if (!Accept("MATERIALIZED") && IsKw("NOT") && IsKwAt(1, "MATERIALIZED")) p += 2;
                    ExpectOp("("); QueryStmt sub = Query(); ExpectOp(")");
                    sub.Cols = cols;
                    q.With.Add(new KeyValuePair<string, QueryStmt>(name, sub));
                } while (AcceptOp(","));
            }
            q.Body = SetExpr();
            if (Accept("ORDER"))
            {
                Accept("SIBLINGS");
                Expect("BY");
                if (IsKw("ALL") && !(Peek(1).T == Tk.Op && Peek(1).V == "("))
                {
                    if (Oracle) throw NotOra("ORDER BY ALL", "ORDER BY with the column names");
                    p++; q.OrderAll = true; if (Accept("DESC")) q.OrderAllDesc = true; else Accept("ASC");
                }
                else q.Order = OrderList();
            }
            // Oracle: [OFFSET n ROW[S]] [FETCH FIRST | NEXT [n] ROW[S] ONLY]. Lenient (internal SQL) also LIMIT n / OFFSET n.
            for (int k = 0; k < 2; k++)
            {
                if (IsKw("LIMIT"))
                {
                    if (Oracle) throw NotOra("LIMIT", "FETCH FIRST n ROWS ONLY");
                    p++; q.Limit = IntLit();
                }
                if (Accept("OFFSET"))
                {
                    q.Offset = IntLit();
                    if (!Accept("ROWS") && !Accept("ROW") && Oracle) throw Err("Expected ROWS after OFFSET n (Oracle: OFFSET n ROWS)");
                }
                if (Accept("FETCH"))
                {
                    if (!Accept("FIRST")) Expect("NEXT");
                    q.Limit = IsKw("ROW") || IsKw("ROWS") ? 1 : IntLit();
                    if (IsKw("PERCENT")) throw Err("FETCH ... PERCENT is not supported; use FETCH FIRST n ROWS ONLY");
                    if (!Accept("ROWS")) Expect("ROW");
                    if (IsKw("WITH")) throw Err("FETCH ... WITH TIES is not supported; use FETCH FIRST n ROWS ONLY");
                    Expect("ONLY");
                }
            }
            return q;
        }
        private long IntLit()
        {
            if (Cur.T != Tk.Num) throw Err("Expected a number but found " + Cur);
            return (long)double.Parse(t[p++].V, CultureInfo.InvariantCulture);
        }
        private object SetExpr()
        {
            object left = SelectTerm();
            while (IsKw("UNION") || IsKw("EXCEPT") || IsKw("INTERSECT") || IsKw("MINUS"))
            {
                if (Oracle && IsKw("EXCEPT")) throw NotOra("EXCEPT", "MINUS");
                SetOp s = new SetOp(); s.Op = t[p++].V.ToUpperInvariant();
                if (s.Op == "MINUS") s.Op = "EXCEPT";
                if (Oracle && (IsKw("DISTINCT") || IsKw("BY"))) throw NotOra(s.Op + " " + Cur.V.ToUpperInvariant(), null);
                if (Accept("ALL")) s.All = true; else Accept("DISTINCT");
                if (Accept("BY")) Expect("NAME");
                s.Left = left; s.Right = SelectTerm();
                left = s;
            }
            return left;
        }
        private object SelectTerm()
        {
            if (IsOp("(")) { p++; QueryStmt q = Query(); ExpectOp(")"); return q; }
            if (IsKw("VALUES")) return ValuesP();
            if (IsKw("FROM"))
            {
                if (Oracle) throw NotOra("A query starting with FROM", "SELECT * FROM ...");
                p++; SelectStmt fs = new SelectStmt(); fs.From = FromList(); SelectItem si = new SelectItem(); si.E = new StarE(); fs.Items.Add(si); if (Accept("WHERE")) fs.Where = Expression(); return fs;
            }
            Expect("SELECT");
            SelectStmt s = new SelectStmt();
            if (Accept("DISTINCT") || Accept("UNIQUE")) s.Distinct = true; else Accept("ALL");
            do { s.Items.Add(SelectItemP()); } while (AcceptOp(",") && !IsKw("FROM"));
            if (Oracle && s.Items.Count > 1 && s.Items.Exists(x => x.E is StarE && ((StarE)x.E).Table == null))
                throw NotOra("* next to other columns", "table.* (e.g. SELECT t.*, x FROM t)");
            if (IsKw("INTO"))
            {
                if (Oracle) throw NotOra("SELECT ... INTO", "CREATE TABLE name AS SELECT ...");
                p++; s.Into = TableName();
            }
            if (Accept("FROM")) s.From = FromList();   // no FROM: one row (Oracle 23ai; FROM DUAL works everywhere)
            if (Accept("WHERE")) s.Where = Expression();
            if (Accept("GROUP"))
            {
                Expect("BY");
                if (IsKw("ALL"))
                {
                    if (Oracle) throw NotOra("GROUP BY ALL", "GROUP BY with the column names");
                    p++; s.GroupAll = true;
                }
                else do { s.GroupBy.Add(IsKw("GROUPING") && IsKwAt(1, "SETS") ? GroupingSets() : Expression()); } while (AcceptOp(","));
            }
            if (Accept("HAVING")) s.Having = Expression();
            if (IsKw("QUALIFY")) throw NotOra("QUALIFY", "a subquery: SELECT * FROM (SELECT ..., ROW_NUMBER() OVER (...) rn FROM ...) WHERE rn = 1");
            // ROWNUM: WHERE ROWNUM <= n limits the rows before ORDER BY (the select is wrapped: (SELECT ... FETCH n)).
            long rowLimit = -1;
            if (s.Where != null) s.Where = TakeRownum(s.Where, ref rowLimit);
            if (s.Where != null && HasRownum(s.Where)) throw Err("ROWNUM in WHERE is supported as ROWNUM <= n, ROWNUM < n or ROWNUM = 1");
            foreach (SelectItem it in s.Items) it.E = RownumToRowNumber(it.E);
            if (rowLimit >= 0) { QueryStmt w = new QueryStmt(); w.Body = s; w.Limit = rowLimit; return w; }
            return s;
        }
        // Removes the top-level ROWNUM <= n / < n / = 1 condition (AND-ed) and returns the rest (null = nothing left).
        Expr TakeRownum(Expr e, ref long limit)
        {
            BinOp b = e as BinOp;
            if (b == null) return e;
            if (b.Op == "AND")
            {
                Expr l = TakeRownum(b.L, ref limit), r = TakeRownum(b.R, ref limit);
                if (l == null) return r; if (r == null) return l;
                b.L = l; b.R = r; return b;
            }
            string op = b.Op; Expr num = null;
            if (b.L is RownumE) num = b.R;
            else if (b.R is RownumE) { num = b.L; op = op == ">=" ? "<=" : op == ">" ? "<" : op == "=" ? "=" : null; }
            Lit l2 = num as Lit;
            if (l2 == null || !(l2.Value is long) || op == null) return e;
            long v = (long)l2.Value, n;
            if (op == "<=") n = v; else if (op == "<") n = v - 1; else if (op == "=" && v == 1) n = 1; else if (op == "=") n = 0; else return e;
            n = Math.Max(0, n);
            limit = limit < 0 ? n : Math.Min(limit, n);
            return null;
        }
        static bool HasRownum(Expr e)
        {
            bool found = false;
            Map(e, x => { if (x is RownumE) found = true; return x; });
            return found;
        }
        static Expr RownumToRowNumber(Expr e)
        {
            return Map(e, x => { if (!(x is RownumE)) return x; Call c = new Call(); c.Name = "row_number"; c.Over = new WindowSpec(); return c; });
        }
        // Rebuilds an expression bottom-up through f (operators, calls, CASE, CAST, IN, BETWEEN, LIKE, IS NULL).
        static Expr Map(Expr e, Func<Expr, Expr> f)
        {
            if (e == null) return null;
            BinOp b = e as BinOp; if (b != null) { b.L = Map(b.L, f); b.R = Map(b.R, f); return f(b); }
            UnOp u = e as UnOp; if (u != null) { u.X = Map(u.X, f); return f(u); }
            Call c = e as Call; if (c != null) { for (int i = 0; i < c.Args.Count; i++) c.Args[i] = Map(c.Args[i], f); return f(c); }
            CaseE k = e as CaseE;
            if (k != null) { k.Operand = Map(k.Operand, f); for (int i = 0; i < k.Whens.Count; i++) { k.Whens[i] = Map(k.Whens[i], f); k.Thens[i] = Map(k.Thens[i], f); } k.Else = Map(k.Else, f); return f(k); }
            CastE ca = e as CastE; if (ca != null) { ca.X = Map(ca.X, f); return f(ca); }
            IsNullE isn = e as IsNullE; if (isn != null) { isn.X = Map(isn.X, f); return f(isn); }
            InE ie = e as InE; if (ie != null) { ie.X = Map(ie.X, f); for (int i = 0; i < ie.List.Count; i++) ie.List[i] = Map(ie.List[i], f); return f(ie); }
            BetweenE bt = e as BetweenE; if (bt != null) { bt.X = Map(bt.X, f); bt.Lo = Map(bt.Lo, f); bt.Hi = Map(bt.Hi, f); return f(bt); }
            LikeE lk = e as LikeE; if (lk != null) { lk.X = Map(lk.X, f); lk.Pat = Map(lk.Pat, f); return f(lk); }
            return f(e);
        }
        private ValuesBody ValuesP()
        {
            Expect("VALUES");
            ValuesBody v = new ValuesBody();
            do
            {
                ExpectOp("(");
                List<Expr> row = new List<Expr>();
                do { row.Add(Expression()); } while (AcceptOp(","));
                ExpectOp(")");
                if (v.Rows.Count > 0 && row.Count != v.Rows[0].Count) throw Err("VALUES rows have different numbers of values (" + v.Rows[0].Count + " and " + row.Count + ")");
                v.Rows.Add(row);
            } while (AcceptOp(","));
            return v;
        }
        // GROUPING SETS ((a, b), (a), ()) / (a, b) / a
        private GroupingSetsE GroupingSets()
        {
            p += 2; GroupingSetsE g = new GroupingSetsE();
            ExpectOp("(");
            do
            {
                List<Expr> set = new List<Expr>();
                if (AcceptOp("(")) { if (!IsOp(")")) do { set.Add(Expression()); } while (AcceptOp(",")); ExpectOp(")"); }
                else set.Add(Expression());
                g.Sets.Add(set);
            } while (AcceptOp(","));
            ExpectOp(")");
            return g;
        }
        // name or schema.name (schema dropped)
        public string TableName()
        {
            string name = Name();
            while (IsOp(".") && (Peek(1).T == Tk.Ident || Peek(1).T == Tk.QIdent)) { p++; name = Name(); }
            return name;
        }
        private SelectItem SelectItemP()
        {
            SelectItem it = new SelectItem();
            if (IsOp("*")) { p++; it.E = StarRest(null); return it; }
            if ((Cur.T == Tk.Ident || Cur.T == Tk.QIdent) && Peek(1).T == Tk.Op && Peek(1).V == "." && Peek(2).T == Tk.Op && Peek(2).V == "*")
            { string tb = Name(); p += 2; it.E = StarRest(tb); return it; }
            it.E = Expression();
            if (Accept("AS")) it.Alias = Name();
            else if (Cur.T == Tk.QIdent || (Cur.T == Tk.Ident && !Reserved.Contains(Cur.V))) it.Alias = Name();
            return it;
        }
        private StarE StarRest(string table)
        {
            StarE s = new StarE(); s.Table = table;
            if (Oracle && IsKw("EXCLUDE")) throw NotOra("* EXCLUDE (...)", "the column names you want");
            if (Accept("EXCLUDE"))
            {
                if (AcceptOp("(")) { do { s.Exclude.Add(Name()); } while (AcceptOp(",")); ExpectOp(")"); }
                else s.Exclude.Add(Name());
            }
            return s;
        }
        public List<OrderItem> OrderList()
        {
            List<OrderItem> r = new List<OrderItem>();
            do
            {
                OrderItem o = new OrderItem(); o.E = Expression();
                if (Accept("DESC")) o.Desc = true; else Accept("ASC");
                if (Accept("NULLS")) { if (Accept("FIRST")) o.Nulls = 1; else { Expect("LAST"); o.Nulls = 2; } }
                r.Add(o);
            } while (AcceptOp(","));
            return r;
        }

        private TableRef FromList()
        {
            TableRef left = JoinChain();
            while (AcceptOp(","))
            {
                JoinRef j = new JoinRef(); j.Kind = "CROSS"; j.Left = left; j.Right = JoinChain(); left = j;
            }
            return left;
        }
        private TableRef JoinChain()
        {
            TableRef left = TablePrimary();
            while (true)
            {
                string kind = null; bool natural = false;
                int save = p;
                if (Accept("NATURAL")) natural = true;
                if (Accept("JOIN")) kind = "INNER";
                else if (Accept("INNER")) { Expect("JOIN"); kind = "INNER"; }
                else if (Accept("LEFT")) { Accept("OUTER"); Expect("JOIN"); kind = "LEFT"; }
                else if (Accept("RIGHT")) { Accept("OUTER"); Expect("JOIN"); kind = "RIGHT"; }
                else if (Accept("FULL")) { Accept("OUTER"); Expect("JOIN"); kind = "FULL"; }
                else if (Accept("CROSS")) { Expect("JOIN"); kind = "CROSS"; }
                if (kind == null) { p = save; return left; }
                if (natural) throw Err("NATURAL JOIN is not supported; use USING (...)");
                JoinRef j = new JoinRef(); j.Kind = kind; j.Left = left; j.Right = TablePrimary();
                if (kind != "CROSS")
                {
                    if (Accept("ON")) j.On = Expression();
                    else if (Accept("USING")) { ExpectOp("("); j.Using = new List<string>(); do { j.Using.Add(Name()); } while (AcceptOp(",")); ExpectOp(")"); }
                    else throw Err("Expected ON or USING after JOIN");
                }
                left = j;
            }
        }
        private TableRef TablePrimary()
        {
            TableRef r;
            if (IsOp("("))
            {
                p++;
                if (IsKw("SELECT") || IsKw("WITH") || IsKw("FROM") || IsKw("VALUES") || IsOp("("))
                {
                    SubqueryTable sq = new SubqueryTable(); sq.Query = Query(); ExpectOp(")"); r = sq;
                }
                else { r = FromList(); ExpectOp(")"); }
            }
            else
            {
                string name = Name();
                while (IsOp(".") && (Peek(1).T == Tk.Ident || Peek(1).T == Tk.QIdent)) { p++; name = Name(); }  // schema.table -> table
                if (IsOp("("))
                {
                    p++;
                    FuncTable f = new FuncTable(); f.Name = name.ToLowerInvariant();
                    if (!IsOp(")"))
                    {
                        do
                        {
                            if ((Cur.T == Tk.Ident) && Peek(1).T == Tk.Op && (Peek(1).V == "=" || Peek(1).V == ":="))
                            { string k = t[p].V; p += 2; f.Named[k] = Expression(); }
                            else f.Args.Add(Expression());
                        } while (AcceptOp(","));
                    }
                    ExpectOp(")");
                    r = f;
                }
                else if (string.Equals(name, "DUAL", StringComparison.OrdinalIgnoreCase))
                {
                    // Oracle's one-row table: one column DUMMY = 'X'.
                    SubqueryTable du = new SubqueryTable(); du.Query = ParseQuery("SELECT 'X' AS DUMMY"); du.Alias = "DUAL"; r = du;
                }
                else { NamedTable nt = new NamedTable(); nt.Name = name; r = nt; }
            }
            if (IsKw("AS"))
            {
                if (Oracle) throw NotOra("AS before a table alias", "the alias alone (FROM sales s)");
                p++; r.Alias = Name();
            }
            else if (Cur.T == Tk.QIdent || (Cur.T == Tk.Ident && !Reserved.Contains(Cur.V))) r.Alias = Name();
            if (r.Alias != null && IsOp("("))
            {
                if (Oracle) throw NotOra("Column names after a table alias, alias(a, b),", "column aliases in the subquery");
                p++; r.ColAliases = new List<string>(); do { r.ColAliases.Add(Name()); } while (AcceptOp(",")); ExpectOp(")");   // t(a, b): rename columns
            }
            while (IsKw("PIVOT"))
            {
                p++; PivotRef pv = new PivotRef(); pv.Source = r;
                ExpectOp("(");
                Expr agg = Expression(); pv.Agg = agg as Call;
                if (pv.Agg == null || !Functions.Aggregates.Contains(pv.Agg.Name)) throw Err("PIVOT needs an aggregate, e.g. PIVOT (SUM(x) FOR col IN (...))");
                Expect("FOR"); pv.For = Postfix(); Expect("IN"); ExpectOp("(");
                do
                {
                    pv.Values.Add(Expression());
                    pv.ValueAliases.Add(Accept("AS") || Cur.T == Tk.QIdent || (Cur.T == Tk.Ident && !Reserved.Contains(Cur.V)) ? Name() : null);
                } while (AcceptOp(","));
                ExpectOp(")"); ExpectOp(")");
                if (Accept("AS")) pv.Alias = Name();
                else if (Cur.T == Tk.QIdent || (Cur.T == Tk.Ident && !Reserved.Contains(Cur.V))) pv.Alias = Name();
                r = pv;
            }
            return r;
        }

        // ---------- expressions ----------
        public Expr Expression() { return Or(); }
        private Expr Or()
        {
            Expr l = And();
            while (Accept("OR")) { BinOp b = new BinOp(); b.Op = "OR"; b.L = l; b.R = And(); l = b; }
            return l;
        }
        private Expr And()
        {
            Expr l = Not();
            while (Accept("AND")) { BinOp b = new BinOp(); b.Op = "AND"; b.L = l; b.R = Not(); l = b; }
            return l;
        }
        private Expr Not()
        {
            if (Accept("NOT")) { UnOp u = new UnOp(); u.Op = "NOT"; u.X = Not(); return u; }
            return Compare();
        }
        private Expr Compare()
        {
            Expr l = Concat();
            while (true)
            {
                if (Cur.T == Tk.Op && (Cur.V == "=" || Cur.V == "==" || Cur.V == "<>" || Cur.V == "!=" || Cur.V == "<" || Cur.V == ">" || Cur.V == "<=" || Cur.V == ">="))
                {
                    if (Oracle && Cur.V == "==") throw NotOra("==", "=");
                    string op = t[p++].V; if (op == "==") op = "="; if (op == "!=") op = "<>";
                    if ((IsKw("ANY") || IsKw("SOME") || IsKw("ALL")) && Peek(1).T == Tk.Op && Peek(1).V == "(" && (IsKwAt(2, "SELECT") || IsKwAt(2, "WITH")))
                    {
                        QuantE qe = new QuantE(); qe.All = IsKw("ALL"); qe.Op = op; qe.X = l; p += 2; qe.Q = Query(); ExpectOp(")"); l = qe; continue;
                    }
                    BinOp b = new BinOp(); b.Op = op; b.L = l; b.R = Concat(); l = b; continue;
                }
                if (IsKw("IS"))
                {
                    p++; bool not = Accept("NOT");
                    if (Accept("NULL")) { IsNullE e = new IsNullE(); e.X = l; e.Not = not; l = e; continue; }
                    if (Accept("DISTINCT")) { Expect("FROM"); BinOp b = new BinOp(); b.Op = not ? "IS NOT DISTINCT FROM" : "IS DISTINCT FROM"; b.L = l; b.R = Concat(); l = b; continue; }
                    if (Accept("TRUE")) { BinOp b = new BinOp(); b.Op = not ? "IS DISTINCT FROM" : "IS NOT DISTINCT FROM"; b.L = l; b.R = BoolLit(true); l = b; continue; }
                    if (Accept("FALSE")) { BinOp b = new BinOp(); b.Op = not ? "IS DISTINCT FROM" : "IS NOT DISTINCT FROM"; b.L = l; b.R = BoolLit(false); l = b; continue; }
                    throw Err("Expected NULL after IS");
                }
                bool neg = false; int save = p;
                if (IsKw("NOT") && (IsKwAt(1, "IN") || IsKwAt(1, "BETWEEN") || IsKwAt(1, "LIKE") || IsKwAt(1, "ILIKE"))) { p++; neg = true; }
                if (Accept("IN"))
                {
                    InE e = new InE(); e.X = l; e.Not = neg; ExpectOp("(");
                    if (IsKw("SELECT") || IsKw("WITH")) { InSubE se = new InSubE(); se.X = l; se.Not = neg; se.Q = Query(); ExpectOp(")"); l = se; continue; }
                    if (!IsOp(")")) do { e.List.Add(Expression()); } while (AcceptOp(","));
                    ExpectOp(")"); l = e; continue;
                }
                if (Accept("BETWEEN"))
                {
                    BetweenE e = new BetweenE(); e.X = l; e.Not = neg; e.Lo = Concat(); Expect("AND"); e.Hi = Concat(); l = e; continue;
                }
                if (IsKw("LIKE") || IsKw("ILIKE"))
                {
                    if (Oracle && IsKw("ILIKE")) throw NotOra("ILIKE", "UPPER(x) LIKE UPPER(pattern), or REGEXP_LIKE(x, pattern, 'i')");
                    LikeE e = new LikeE(); e.Insensitive = string.Equals(t[p++].V, "ILIKE", StringComparison.OrdinalIgnoreCase); e.X = l; e.Not = neg; e.Pat = Concat();
                    if (Accept("ESCAPE"))
                    {
                        if (Cur.T != Tk.Str || Cur.V.Length != 1) throw Err("ESCAPE needs one character in quotes, e.g. ESCAPE '\\'");
                        e.Escape = t[p++].V[0];
                    }
                    l = e; continue;
                }
                p = save;
                return l;
            }
        }
        private static Lit BoolLit(bool v) { Lit x = new Lit(); x.Value = v; x.Type = DataType.Bool; return x; }
        private Expr Concat()
        {
            Expr l = Add();
            while (IsOp("||")) { p++; BinOp b = new BinOp(); b.Op = "||"; b.L = l; b.R = Add(); l = b; }
            return l;
        }
        private Expr Add()
        {
            Expr l = Mul();
            while (IsOp("+") || IsOp("-"))
            {
                string op = t[p++].V; Expr r = Mul();
                IntervalE iv = r as IntervalE;
                if (iv != null)
                {
                    // d +/- INTERVAL: months -> ADD_MONTHS, days (or parts of a day) -> d +/- n
                    if (iv.IsMonths) { Call am = new Call(); am.Name = "add_months"; am.Args.Add(l); Lit m = new Lit(); m.Value = op == "-" ? -iv.Months : iv.Months; m.Type = DataType.BigInt; am.Args.Add(m); l = am; continue; }
                    Lit d = new Lit(); d.Value = iv.Days; d.Type = iv.Days is long ? DataType.BigInt : DataType.Double; r = d;
                }
                if (l is IntervalE) throw Err("Put the date first: date + INTERVAL ...");
                BinOp b = new BinOp(); b.Op = op; b.L = l; b.R = r; l = b;
            }
            return l;
        }
        private Expr Mul()
        {
            Expr l = Unary();
            while (IsOp("*") || IsOp("/") || IsOp("%") || IsOp("//"))
            {
                if (Oracle && IsOp("%")) throw NotOra("%", "MOD(a, b)");
                if (Oracle && IsOp("//")) throw NotOra("//", "FLOOR(a / b)");
                BinOp b = new BinOp(); b.Op = t[p++].V; b.L = l; b.R = Unary(); l = b;
            }
            return l;
        }
        private Expr Unary()
        {
            if (IsOp("-"))
            {
                p++; Expr x = Unary();
                Lit lit = x as Lit;
                if (lit != null && lit.Value is long) { lit.Value = -(long)lit.Value; return lit; }
                if (lit != null && lit.Value is double) { lit.Value = -(double)lit.Value; return lit; }
                UnOp u = new UnOp(); u.Op = "-"; u.X = x; return u;
            }
            if (IsOp("+")) { p++; return Unary(); }
            return Postfix();
        }
        private Expr Postfix()
        {
            Expr e = Primary();
            while (IsOp("::"))
            {
                if (Oracle) throw NotOra("::", "CAST(x AS type)");
                p++; CastE c = new CastE(); c.X = e; c.T = TypeName(); e = c;
            }
            return e;
        }
        // Oracle type names (the engine's own names are accepted in lenient mode).
        static readonly HashSet<string> OraTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "VARCHAR2", "NVARCHAR2", "VARCHAR", "CHAR", "NCHAR", "CLOB", "NCLOB", "LONG", "NUMBER", "INTEGER", "INT", "SMALLINT",
            "DECIMAL", "NUMERIC", "DEC", "FLOAT", "BINARY_FLOAT", "BINARY_DOUBLE", "REAL", "DOUBLE", "DATE", "TIMESTAMP", "BOOLEAN" };
        public DataType TypeName() { string dummy; return TypeName(out dummy); }
        // name: the base type name as written (DATE for CAST(x AS DATE), which keeps a time like Oracle).
        public DataType TypeName(out string name)
        {
            name = Name();
            if (Oracle && !OraTypes.Contains(name)) throw NotOra("Type " + name.ToUpperInvariant(), "VARCHAR2(n), NUMBER, NUMBER(p,s), INTEGER, BINARY_DOUBLE, DATE, TIMESTAMP or BOOLEAN");
            StringBuilder sb = new StringBuilder(name);
            if (IsKw("PRECISION")) p++;   // DOUBLE PRECISION
            if (IsKw("VARYING")) p++;     // CHARACTER VARYING
            if (IsOp("("))
            {
                p++; sb.Append('(');
                do
                {
                    sb.Append(t[p++].V);
                    if (IsKw("BYTE") || IsKw("CHAR")) p++;   // VARCHAR2(20 CHAR)
                    if (IsOp(",")) sb.Append(',');
                } while (AcceptOp(","));
                ExpectOp(")"); sb.Append(')');
            }
            if (IsKw("WITH") && (IsKwAt(1, "TIME") || IsKwAt(1, "LOCAL"))) { p += 2; Accept("TIME"); Accept("ZONE"); }
            if (IsKw("WITHOUT") && IsKwAt(1, "TIME")) { p += 2; Accept("ZONE"); }
            string s = sb.ToString();
            if (s.StartsWith("TIMESTAMP(", StringComparison.OrdinalIgnoreCase)) s = "TIMESTAMP";
            if (Oracle && string.Equals(name, "LONG", StringComparison.OrdinalIgnoreCase)) s = "VARCHAR";   // Oracle LONG = long text
            return DataType.Parse(s);
        }

        private Expr Primary()
        {
            Token c = Cur;
            if (c.T == Tk.Num)
            {
                p++; Lit l = new Lit();
                if (c.V.IndexOf('.') < 0 && c.V.IndexOf('e') < 0 && c.V.IndexOf('E') < 0)
                {
                    long v; if (long.TryParse(c.V, NumberStyles.None, CultureInfo.InvariantCulture, out v)) { l.Value = v; l.Type = DataType.BigInt; return l; }
                }
                double dv; if (!Values.ParseDouble(c.V, out dv)) dv = double.Parse(c.V, CultureInfo.InvariantCulture); l.Value = dv; l.Type = DataType.Double; return l;
            }
            if (c.T == Tk.Str)
            {
                p++; Lit l = new Lit();
                if (c.V.Length == 0) { l.Value = null; l.Type = DataType.Null; return l; }   // Oracle: '' is NULL
                l.Value = c.V; l.Type = DataType.Varchar; return l;
            }
            if (c.T == Tk.Op && c.V == "(")
            {
                p++;
                if (IsKw("SELECT") || IsKw("WITH")) { SubqueryE sq = new SubqueryE(); sq.Q = Query(); ExpectOp(")"); return sq; }
                Expr e = Expression();
                if (IsOp(","))
                {
                    RowE r = new RowE(); r.Items.Add(e);
                    while (AcceptOp(",")) r.Items.Add(Expression());
                    ExpectOp(")"); return r;
                }
                ExpectOp(")"); return e;
            }
            if (c.T == Tk.Op && c.V == "[")
            {
                if (Oracle) throw NotOra("[...]", "\"name\" for names, or IN (a, b) for a list");
                p++; ListE le = new ListE();
                if (!IsOp("]")) do { le.Items.Add(Expression()); } while (AcceptOp(","));
                ExpectOp("]"); return le;
            }
            if (c.T == Tk.Op && c.V == "*") { p++; return new StarE(); }
            if (c.T == Tk.QIdent)
            {
                p++; return ColumnRest(c.V);
            }
            if (c.T != Tk.Ident) throw Err("Unexpected " + c);
            string u = c.V.ToUpperInvariant();
            switch (u)
            {
                case "NULL": p++; { Lit l = new Lit(); l.Value = null; l.Type = DataType.Null; return l; }
                case "TRUE": p++; return BoolLit(true);
                case "FALSE": p++; return BoolLit(false);
                case "CASE": p++; return CaseRest();
                case "CAST": case "TRY_CAST":
                    if (Peek(1).V == "(")
                    {
                        if (Oracle && u == "TRY_CAST") throw NotOra("TRY_CAST", "CAST(x AS type DEFAULT NULL ON CONVERSION ERROR)");
                        p += 2; CastE ce = new CastE(); ce.Try = u == "TRY_CAST"; ce.X = Expression(); Expect("AS"); string tn; ce.T = TypeName(out tn);
                        Expr def = null;
                        if (Accept("DEFAULT")) { def = Expression(); Expect("ON"); Expect("CONVERSION"); Expect("ERROR"); ce.Try = true; }
                        ExpectOp(")");
                        Expr res = ce;
                        // Oracle DATE keeps the time: CAST(timestamp AS DATE) stays a date-time (__cast_date).
                        if (string.Equals(tn, "DATE", StringComparison.OrdinalIgnoreCase)) { Call cd = new Call(); cd.Name = ce.Try ? "__try_cast_date" : "__cast_date"; cd.Args.Add(ce.X); res = cd; }
                        return def == null ? res : OnConversionError(ce.X, res, def);
                    }
                    break;
                case "DATE": case "TIMESTAMP":
                    if (Peek(1).T == Tk.Str)
                    {
                        p++; string s = t[p++].V; Lit l = new Lit();
                        long v;
                        if (u == "DATE") { if (!Values.ParseDate(s, out v)) throw Err("Invalid date '" + s + "'"); l.Type = DataType.Date; }
                        else { if (!Values.ParseTimestamp(s, out v)) throw Err("Invalid timestamp '" + s + "'"); l.Type = DataType.Timestamp; }
                        l.Value = v; return l;
                    }
                    break;
                case "INTERVAL":
                    if (Peek(1).T == Tk.Str || Peek(1).T == Tk.Num)
                    {
                        // INTERVAL 'n' DAY | HOUR | MINUTE | SECOND | MONTH | YEAR [(precision)]
                        p++; string txt = t[p++].V.Trim(); string unit = Name().ToUpperInvariant();
                        if (IsOp("(")) { p++; IntLit(); ExpectOp(")"); }
                        if (IsKw("TO")) throw Err("INTERVAL ... TO ... is not supported; add the parts separately (d + INTERVAL '1' DAY + INTERVAL '2' HOUR)");
                        double v; if (!double.TryParse(txt, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) throw Err("INTERVAL needs a number, e.g. INTERVAL '3' DAY");
                        IntervalE iv = new IntervalE();
                        switch (unit)
                        {
                            case "YEAR": iv.IsMonths = true; iv.Months = (long)(v * 12); break;
                            case "MONTH": iv.IsMonths = true; iv.Months = (long)v; break;
                            case "DAY": iv.Days = v == Math.Floor(v) ? (object)(long)v : v; break;
                            case "HOUR": iv.Days = v / 24; break;
                            case "MINUTE": iv.Days = v / 1440; break;
                            case "SECOND": iv.Days = v / 86400; break;
                            default: throw Err("INTERVAL unit must be YEAR, MONTH, DAY, HOUR, MINUTE or SECOND");
                        }
                        return iv;
                    }
                    break;
                case "SYSDATE": case "SYSTIMESTAMP": case "LOCALTIMESTAMP": case "SQLERRM": case "SQLCODE": case "ROWNUM":
                    if (Peek(1).T == Tk.Op && (Peek(1).V == "(" || Peek(1).V == ".")) break;
                    p++;
                    if (u == "ROWNUM") return new RownumE();
                    { Call sc = new Call(); sc.Name = u == "SYSDATE" ? "sysdate" : u == "SQLERRM" ? "error_message" : u == "SQLCODE" ? "error_number" : "systimestamp"; return sc; }
                case "TRIM":
                    if (Peek(1).V == "(")
                    {
                        // TRIM([LEADING | TRAILING | BOTH] [c] [FROM] s)
                        p += 2; string fn = "trim";
                        if (Accept("LEADING")) fn = "ltrim"; else if (Accept("TRAILING")) fn = "rtrim"; else Accept("BOTH");
                        Expr ch = null, s;
                        if (Accept("FROM")) s = Expression();
                        else { s = Expression(); if (Accept("FROM")) { ch = s; s = Expression(); } }
                        ExpectOp(")");
                        Call tc = new Call(); tc.Name = fn; tc.Args.Add(s);
                        Lit sp = new Lit(); sp.Value = " "; sp.Type = DataType.Varchar;
                        tc.Args.Add(ch ?? sp);
                        return tc;
                    }
                    break;
                case "EXISTS":
                    if (Peek(1).V == "(") { p += 2; ExistsE ex = new ExistsE(); ex.Q = Query(); ExpectOp(")"); return ex; }
                    break;
                case "EXTRACT":
                    if (Peek(1).V == "(")
                    {
                        p += 2; string part = Name(); Expect("FROM"); Expr x = Expression(); ExpectOp(")");
                        Call call = new Call(); call.Name = "date_part"; Lit pl = new Lit(); pl.Value = part.ToLowerInvariant(); pl.Type = DataType.Varchar;
                        call.Args.Add(pl); call.Args.Add(x); return call;
                    }
                    break;
                // Oracle: CURRENT_DATE is a DATE with the time of day (= SYSDATE); CURRENT_TIMESTAMP = SYSTIMESTAMP.
                case "CURRENT_DATE": p++; { Call cd = new Call(); cd.Name = "sysdate"; return cd; }
                case "CURRENT_TIMESTAMP": p++; { Call cd = new Call(); cd.Name = "systimestamp"; if (IsOp("(")) { p++; IntLit(); ExpectOp(")"); } return cd; }
            }
            p++;
            if (IsOp("(")) return CallRest(c.V);
            return ColumnRest(c.V);
        }
        private Expr ColumnRest(string first)
        {
            if (IsOp(".") && (Peek(1).T == Tk.Ident || Peek(1).T == Tk.QIdent))
            {
                p++; string second = Name();
                if (IsOp(".") && (Peek(1).T == Tk.Ident || Peek(1).T == Tk.QIdent)) { p++; string third = Name(); ColName c3 = new ColName(); c3.Table = second; c3.Name = third; return c3; }
                ColName c2 = new ColName(); c2.Table = first; c2.Name = second; return c2;
            }
            if (IsOp(".") && Peek(1).V == "*") { p += 2; return StarRest(first); }
            ColName c = new ColName(); c.Name = first; return c;
        }
        private Expr CaseRest()
        {
            CaseE e = new CaseE();
            if (!IsKw("WHEN")) e.Operand = Expression();
            while (Accept("WHEN")) { e.Whens.Add(Expression()); Expect("THEN"); e.Thens.Add(Expression()); }
            if (e.Whens.Count == 0) throw Err("CASE needs at least one WHEN");
            if (Accept("ELSE")) e.Else = Expression();
            Expect("END");
            return e;
        }
        // Oracle functions accepted in user SQL (aggregates and analytic functions included).
        static readonly HashSet<string> OraFns = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "abs", "ceil", "floor", "round", "trunc", "mod", "remainder", "power", "sqrt", "exp", "ln", "log", "sign", "sin", "cos", "tan",
            "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "bitand", "greatest", "least",
            "lower", "upper", "initcap", "length", "substr", "instr", "replace", "translate", "concat", "lpad", "rpad", "ltrim", "rtrim",
            "trim", "chr", "ascii", "reverse", "soundex", "regexp_like", "regexp_substr", "regexp_replace", "regexp_instr", "regexp_count",
            "nvl", "nvl2", "nullif", "coalesce", "decode", "lnnvl",
            "to_char", "to_date", "to_timestamp", "to_number",
            "add_months", "months_between", "last_day", "next_day", "ora_hash",
            "count", "sum", "avg", "min", "max", "median", "stddev", "stddev_samp", "stddev_pop", "variance", "var_samp", "var_pop",
            "any_value", "approx_count_distinct", "stats_mode", "listagg", "percentile_cont", "percentile_disc",
            "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value", "last_value",
            "grouping", "rollup", "cube", "read_dataset", "read_arrow", "read_parquet", "read_csv", "read_sqlite", "range" };
        // The usual non-Oracle names, with the Oracle form to use.
        static readonly Dictionary<string, string> OraHint = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            { "ifnull", "NVL(a, b)" }, { "isnull", "NVL(a, b)" }, { "iff", "CASE WHEN ... THEN ... ELSE ... END" }, { "if", "CASE WHEN ... THEN ... ELSE ... END" },
            { "strptime", "TO_DATE(text, 'MM/DD/YYYY')" }, { "try_strptime", "TO_DATE(text DEFAULT NULL ON CONVERSION ERROR, 'MM/DD/YYYY')" },
            { "strftime", "TO_CHAR(date, 'YYYY-MM-DD')" }, { "date_trunc", "TRUNC(date, 'MM')" }, { "datetrunc", "TRUNC(date, 'MM')" },
            { "date_diff", "date1 - date2 (days) or MONTHS_BETWEEN" }, { "datediff", "date1 - date2 (days) or MONTHS_BETWEEN" },
            { "date_add", "date + n (days) or ADD_MONTHS" }, { "dateadd", "date + n (days) or ADD_MONTHS" }, { "date_part", "EXTRACT(YEAR FROM date)" },
            { "year", "EXTRACT(YEAR FROM date)" }, { "month", "EXTRACT(MONTH FROM date)" }, { "day", "EXTRACT(DAY FROM date)" },
            { "now", "SYSDATE or SYSTIMESTAMP" }, { "today", "TRUNC(SYSDATE)" }, { "getdate", "SYSDATE" }, { "current_date", "SYSDATE" },
            { "string_agg", "LISTAGG(x, ',') WITHIN GROUP (ORDER BY x)" }, { "group_concat", "LISTAGG(x, ',') WITHIN GROUP (ORDER BY x)" },
            { "len", "LENGTH" }, { "char_length", "LENGTH" }, { "substring", "SUBSTR" }, { "strpos", "INSTR(text, find)" }, { "position", "INSTR(text, find)" },
            { "left", "SUBSTR(text, 1, n)" }, { "right", "SUBSTR(text, -n)" }, { "split_part", "REGEXP_SUBSTR(text, '[^,]+', 1, n)" },
            { "contains", "INSTR(text, find) > 0" }, { "starts_with", "text LIKE 'abc%'" }, { "ends_with", "text LIKE '%abc'" },
            { "regexp_matches", "REGEXP_LIKE(text, pattern)" }, { "regexp_extract", "REGEXP_SUBSTR(text, pattern)" },
            { "count_if", "COUNT(CASE WHEN ... THEN 1 END)" }, { "mean", "AVG" }, { "mode", "STATS_MODE" }, { "quantile_cont", "PERCENTILE_CONT(p) WITHIN GROUP (ORDER BY x)" },
            { "first", "MIN / MAX or FIRST_VALUE" }, { "last", "MIN / MAX or LAST_VALUE" }, { "ceiling", "CEIL" }, { "pow", "POWER" }, { "log10", "LOG(10, n)" },
            { "random", "DBMS_RANDOM.VALUE (not supported)" }, { "typeof", "(none)" }, { "hash", "ORA_HASH" }, { "md5", "STANDARD_HASH (not supported)" },
            { "lcase", "LOWER" }, { "ucase", "UPPER" }, { "make_date", "TO_DATE(y || '-' || m || '-' || d, 'YYYY-MM-DD')" } };

        // CAST / TO_DATE / TO_NUMBER ... DEFAULT v ON CONVERSION ERROR: NULL stays NULL, a value that does not convert gives v.
        static Expr OnConversionError(Expr input, Expr tryExpr, Expr def)
        {
            CaseE k = new CaseE();
            IsNullE isn = new IsNullE(); isn.X = input;
            k.Whens.Add(isn); Lit nl = new Lit(); nl.Value = null; nl.Type = DataType.Null; k.Thens.Add(nl);
            Call co = new Call(); co.Name = "coalesce"; co.Args.Add(tryExpr); co.Args.Add(def); k.Else = co;
            return k;
        }
        private Expr CallRest(string name)
        {
            ExpectOp("(");
            Call c = new Call(); c.Name = name.ToLowerInvariant();
            if (Oracle && !OraFns.Contains(c.Name))
            {
                string hint; OraHint.TryGetValue(c.Name, out hint);
                throw Lexer.Err(name.ToUpperInvariant() + "() is not an Oracle function" + (hint != null ? ": use " + hint : ""), t[p - 2].Pos);
            }
            Expr convDefault = null;
            if (IsOp("*")) { p++; c.Star = true; }
            else if (!IsOp(")"))
            {
                if (Accept("DISTINCT") || Accept("UNIQUE")) c.Distinct = true; else Accept("ALL");
                do
                {
                    if (Cur.T == Tk.Ident && Peek(1).T == Tk.Op && Peek(1).V == ":=")
                    {
                        if (Oracle) throw NotOra("name := value", null);
                        p += 2;   // named argument: value only
                    }
                    c.Args.Add(Expression());
                    // TO_DATE / TO_TIMESTAMP / TO_NUMBER (x DEFAULT v ON CONVERSION ERROR, ...)
                    if (c.Args.Count == 1 && IsKw("DEFAULT") && (c.Name == "to_date" || c.Name == "to_timestamp" || c.Name == "to_number"))
                    { p++; convDefault = Expression(); Expect("ON"); Expect("CONVERSION"); Expect("ERROR"); }
                } while (AcceptOp(","));
                if (IsKw("ORDER"))
                {
                    if (Oracle) throw NotOra("ORDER BY inside " + name.ToUpperInvariant() + "()", "LISTAGG(x, ',') WITHIN GROUP (ORDER BY y)");
                    p++; Expect("BY"); OrderList();   // string_agg(x, ',' ORDER BY y): order ignored
                }
            }
            ExpectOp(")");
            if (IsKw("WITHIN") && IsKwAt(1, "GROUP")) { p += 2; ExpectOp("("); Expect("ORDER"); Expect("BY"); c.WithinOrder = OrderList(); ExpectOp(")"); }
            if (IsKw("KEEP")) throw Err("KEEP (DENSE_RANK FIRST / LAST ...) is not supported; use FIRST_VALUE / LAST_VALUE ... OVER (...)");
            if (IsKw("FILTER"))
            {
                if (Oracle) throw NotOra("FILTER (WHERE ...)", "COUNT(CASE WHEN ... THEN 1 END) / SUM(CASE WHEN ... THEN x END)");
                p++; ExpectOp("("); Expect("WHERE"); c.Filter = Expression(); ExpectOp(")");
            }
            if (Accept("OVER"))
            {
                ExpectOp("(");
                WindowSpec w = new WindowSpec();
                if (Accept("PARTITION")) { Expect("BY"); do { w.Partition.Add(Expression()); } while (AcceptOp(",")); }
                if (Accept("ORDER")) { Expect("BY"); w.Order = OrderList(); }
                if (IsKw("ROWS") || IsKw("RANGE"))
                {
                    // Frames: only the default running frame is supported; skip the clause text.
                    int depth = 0;
                    while (!(depth == 0 && IsOp(")")) && Cur.T != Tk.End) { if (IsOp("(")) depth++; if (IsOp(")")) depth--; p++; }
                }
                ExpectOp(")");
                c.Over = w;
            }
            Expr r = OraRewrite(c);
            if (convDefault != null)
            {
                Call tc = (Call)r; tc.Name = "__try_" + tc.Name;
                return OnConversionError(c.Args[0], tc, convDefault);
            }
            return r;
        }
        // Oracle functions written as other expressions / engine functions.
        Expr OraRewrite(Call c)
        {
            switch (c.Name)
            {
                case "nvl":
                    if (c.Args.Count != 2) throw Err("NVL takes 2 arguments: NVL(value, value_if_null)");
                    c.Name = "coalesce"; return c;
                case "nvl2":
                    {
                        if (c.Args.Count != 3) throw Err("NVL2 takes 3 arguments: NVL2(value, if_not_null, if_null)");
                        CaseE k = new CaseE(); IsNullE nn = new IsNullE(); nn.X = c.Args[0]; nn.Not = true;
                        k.Whens.Add(nn); k.Thens.Add(c.Args[1]); k.Else = c.Args[2]; return k;
                    }
                case "decode":
                    {
                        // DECODE(x, s1, r1, s2, r2, ..., [default]); NULL matches NULL
                        if (c.Args.Count < 3) throw Err("DECODE takes at least 3 arguments: DECODE(value, search, result, ..., default)");
                        CaseE k = new CaseE();
                        int i = 1;
                        for (; i + 1 < c.Args.Count; i += 2)
                        {
                            BinOp eq = new BinOp(); eq.Op = "IS NOT DISTINCT FROM"; eq.L = c.Args[0]; eq.R = c.Args[i];
                            k.Whens.Add(eq); k.Thens.Add(c.Args[i + 1]);
                        }
                        if (i < c.Args.Count) k.Else = c.Args[i];
                        return k;
                    }
                case "lnnvl":
                    {
                        if (c.Args.Count != 1) throw Err("LNNVL takes 1 condition");
                        CaseE k = new CaseE(); k.Whens.Add(c.Args[0]); k.Thens.Add(BoolLit(false)); k.Else = BoolLit(true); return k;
                    }
                case "stats_mode": c.Name = "mode"; return c;
                case "ora_hash": if (c.Args.Count > 1) c.Args.RemoveRange(1, c.Args.Count - 1); c.Name = "hash"; return c;
                case "percentile_cont": case "percentile_disc":
                    {
                        // PERCENTILE_CONT(p) WITHIN GROUP (ORDER BY x [DESC]) -> quantile_cont(x, p) (1 - p when DESC)
                        if (c.WithinOrder == null || c.WithinOrder.Count != 1 || c.Args.Count != 1) throw Err(c.Name.ToUpperInvariant() + "(p) needs WITHIN GROUP (ORDER BY column)");
                        Lit pl = c.Args[0] as Lit;
                        if (pl == null || !(pl.Value is double || pl.Value is long)) throw Err(c.Name.ToUpperInvariant() + " needs a constant between 0 and 1");
                        double q = Convert.ToDouble(pl.Value, CultureInfo.InvariantCulture);
                        if (c.WithinOrder[0].Desc) q = 1 - q;
                        Call r = new Call(); r.Name = c.Name == "percentile_cont" ? "quantile_cont" : "quantile_disc"; r.Over = c.Over;
                        Lit ql = new Lit(); ql.Value = q; ql.Type = DataType.Double;
                        r.Args.Add(c.WithinOrder[0].E); r.Args.Add(ql); return r;
                    }
                case "listagg":
                    if (c.Args.Count < 1 || c.Args.Count > 2) throw Err("LISTAGG takes 1 or 2 arguments: LISTAGG(x, ',') WITHIN GROUP (ORDER BY ...)");
                    return c;
            }
            return c;
        }
    }
}
