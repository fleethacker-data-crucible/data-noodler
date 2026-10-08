// SQL subset used by the app (DuckDB-style): SELECT/WITH [RECURSIVE]/UNION, VALUES, joins, GROUP BY
// [ALL | ROLLUP | CUBE | GROUPING SETS], HAVING, ORDER BY [ALL], LIMIT/OFFSET, window functions, CAST/TRY_CAST/::, CASE,
// IN, BETWEEN, LIKE/ILIKE, FILTER (WHERE ...), * EXCLUDE (...), subqueries (scalar, EXISTS, IN, ANY/ALL; correlated
// on equality), PIVOT, [bracket] names, table functions read_parquet / read_csv / read_sqlite / range, DESCRIBE.
// Statements (INSERT, UPDATE, CREATE, ...) are parsed in Script.cs.
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
        public override string Key()
        {
            StringBuilder sb = new StringBuilder(Name.ToLowerInvariant()).Append('(');
            if (Distinct) sb.Append("distinct ");
            if (Star) sb.Append('*');
            for (int i = 0; i < Args.Count; i++) { if (i > 0) sb.Append(','); sb.Append(Args[i].Key()); }
            sb.Append(')');
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
        public Expr X, Pat; public bool Not, Insensitive;
        public override string Key() { return "(" + X.Key() + (Not ? " not" : "") + (Insensitive ? " ilike " : " like ") + Pat.Key() + ")"; }
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
        public static List<Token> Run(string s)
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
                else if (c == '[' && BracketName(s, i) != null)
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
                    if (two == "<>" || two == "!=" || two == "<=" || two == ">=" || two == "||" || two == "::" || two == "//" || two == "==") { t.V = two; i += 2; }
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
            "THROW","RAISERROR","GO","PRINT","WHEN","MATCHED","RETURNING" };

        public Parser(string sql) { src = sql ?? ""; t = Lexer.Run(src); p = 0; }

        public static QueryStmt ParseQuery(string sql)
        {
            Parser ps = new Parser(sql);
            QueryStmt q;
            if (ps.IsKw("DESCRIBE")) { ps.p++; q = ps.Query(); q.Describe = true; }
            else q = ps.Query();
            while (ps.IsOp(";")) ps.p++;
            if (ps.Cur.T != Tk.End) throw ps.Err("Unexpected " + ps.Cur);
            return q;
        }
        public static Expr ParseExpr(string sql)
        {
            Parser ps = new Parser(sql);
            Expr e = ps.Expression();
            if (ps.Cur.T != Tk.End) throw ps.Err("Unexpected " + ps.Cur);
            return e;
        }
        // "a, b DESC" -> order items; "a, b" -> expressions.
        public static List<OrderItem> ParseOrder(string sql)
        {
            Parser ps = new Parser(sql); List<OrderItem> r = ps.OrderList();
            if (ps.Cur.T != Tk.End) throw ps.Err("Unexpected " + ps.Cur);
            return r;
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
                Accept("RECURSIVE");
                do
                {
                    string name = Name();
                    List<string> cols = null;
                    if (IsOp("(")) { p++; cols = new List<string>(); do { cols.Add(Name()); } while (AcceptOp(",")); ExpectOp(")"); }   // name(a, b) AS (...)
                    Expect("AS");
                    if (!Accept("MATERIALIZED") && IsKw("NOT") && IsKwAt(1, "MATERIALIZED")) p += 2;
                    ExpectOp("("); QueryStmt sub = Query(); ExpectOp(")");
                    sub.Cols = cols;
                    q.With.Add(new KeyValuePair<string, QueryStmt>(name, sub));
                } while (AcceptOp(","));
            }
            q.Body = SetExpr();
            if (Accept("ORDER"))
            {
                Expect("BY");
                if (IsKw("ALL")) { p++; q.OrderAll = true; if (Accept("DESC")) q.OrderAllDesc = true; else Accept("ASC"); }
                else q.Order = OrderList();
            }
            for (int k = 0; k < 2; k++)
            {
                if (Accept("LIMIT")) q.Limit = IntLit();
                if (Accept("OFFSET")) q.Offset = IntLit();
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
            while (IsKw("UNION") || IsKw("EXCEPT") || IsKw("INTERSECT"))
            {
                SetOp s = new SetOp(); s.Op = t[p++].V.ToUpperInvariant();
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
            if (IsKw("FROM")) { p++; SelectStmt fs = new SelectStmt(); fs.From = FromList(); SelectItem si = new SelectItem(); si.E = new StarE(); fs.Items.Add(si); if (Accept("WHERE")) fs.Where = Expression(); return fs; }
            Expect("SELECT");
            SelectStmt s = new SelectStmt();
            if (Accept("DISTINCT")) s.Distinct = true; else Accept("ALL");
            do { s.Items.Add(SelectItemP()); } while (AcceptOp(",") && !IsKw("FROM"));
            if (Accept("INTO")) s.Into = TableName();
            if (Accept("FROM")) s.From = FromList();
            if (Accept("WHERE")) s.Where = Expression();
            if (Accept("GROUP"))
            {
                Expect("BY");
                if (IsKw("ALL")) { p++; s.GroupAll = true; }
                else do { s.GroupBy.Add(IsKw("GROUPING") && IsKwAt(1, "SETS") ? GroupingSets() : Expression()); } while (AcceptOp(","));
            }
            if (Accept("HAVING")) s.Having = Expression();
            return s;
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
                else { NamedTable nt = new NamedTable(); nt.Name = name; r = nt; }
            }
            if (Accept("AS")) r.Alias = Name();
            else if (Cur.T == Tk.QIdent || (Cur.T == Tk.Ident && !Reserved.Contains(Cur.V))) r.Alias = Name();
            if (r.Alias != null && IsOp("(")) { p++; r.ColAliases = new List<string>(); do { r.ColAliases.Add(Name()); } while (AcceptOp(",")); ExpectOp(")"); }   // t(a, b): rename columns
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
                    pv.ValueAliases.Add(Accept("AS") ? Name() : null);
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
                    LikeE e = new LikeE(); e.Insensitive = string.Equals(t[p++].V, "ILIKE", StringComparison.OrdinalIgnoreCase); e.X = l; e.Not = neg; e.Pat = Concat(); l = e; continue;
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
            while (IsOp("+") || IsOp("-")) { BinOp b = new BinOp(); b.Op = t[p++].V; b.L = l; b.R = Mul(); l = b; }
            return l;
        }
        private Expr Mul()
        {
            Expr l = Unary();
            while (IsOp("*") || IsOp("/") || IsOp("%") || IsOp("//")) { BinOp b = new BinOp(); b.Op = t[p++].V; b.L = l; b.R = Unary(); l = b; }
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
            while (IsOp("::")) { p++; CastE c = new CastE(); c.X = e; c.T = TypeName(); e = c; }
            return e;
        }
        private DataType TypeName()
        {
            StringBuilder sb = new StringBuilder(Name());
            if (IsKw("PRECISION")) p++;   // DOUBLE PRECISION
            if (IsKw("WITH") && IsKwAt(1, "TIME")) { p += 3; Accept("ZONE"); }
            if (IsOp("("))
            {
                p++; sb.Append('(');
                do { sb.Append(t[p++].V); if (IsOp(",")) sb.Append(','); } while (AcceptOp(","));
                ExpectOp(")"); sb.Append(')');
            }
            return DataType.Parse(sb.ToString());
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
                l.Value = double.Parse(c.V, CultureInfo.InvariantCulture); l.Type = DataType.Double; return l;
            }
            if (c.T == Tk.Str) { p++; Lit l = new Lit(); l.Value = c.V; l.Type = DataType.Varchar; return l; }
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
                        p += 2; CastE ce = new CastE(); ce.Try = u == "TRY_CAST"; ce.X = Expression(); Expect("AS"); ce.T = TypeName(); ExpectOp(")"); return ce;
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
                    if (Peek(1).T == Tk.Str || Peek(1).T == Tk.Num) throw Err("INTERVAL is not supported; use date_add / date_diff");
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
                case "CURRENT_DATE": p++; { Call cd = new Call(); cd.Name = "current_date"; return cd; }
                case "CURRENT_TIMESTAMP": p++; { Call cd = new Call(); cd.Name = "now"; return cd; }
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
        private Expr CallRest(string name)
        {
            ExpectOp("(");
            Call c = new Call(); c.Name = name.ToLowerInvariant();
            if (IsOp("*")) { p++; c.Star = true; }
            else if (!IsOp(")"))
            {
                if (Accept("DISTINCT")) c.Distinct = true; else Accept("ALL");
                do
                {
                    if (Cur.T == Tk.Ident && Peek(1).T == Tk.Op && Peek(1).V == ":=") p += 2;  // named argument: value only
                    c.Args.Add(Expression());
                } while (AcceptOp(","));
                if (Accept("ORDER")) { Expect("BY"); OrderList(); }   // string_agg(x, ',' ORDER BY y): order ignored
            }
            ExpectOp(")");
            if (Accept("FILTER")) { ExpectOp("("); Expect("WHERE"); c.Filter = Expression(); ExpectOp(")"); }
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
            return c;
        }
    }
}
