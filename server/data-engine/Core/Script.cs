// SQL scripts: several statements run in order against a session (in-memory tables and views that live for one
// request). Input datasets are read only; a statement that changes one works on a session copy of it.
//   CREATE TABLE (columns + PRIMARY KEY / UNIQUE / NOT NULL / DEFAULT / CHECK / AUTO_INCREMENT | AS query),
//   CREATE [OR REPLACE] VIEW, DROP TABLE / VIEW / INDEX, ALTER TABLE (ADD / DROP / MODIFY / ALTER / RENAME COLUMN,
//   RENAME TO, ADD constraint), INSERT (VALUES / query / DEFAULT VALUES, ON DUPLICATE KEY UPDATE, ON CONFLICT,
//   OR REPLACE / OR IGNORE), UPDATE, DELETE, TRUNCATE, MERGE, SELECT ... INTO, BEGIN / COMMIT / ROLLBACK,
//   BEGIN TRY ... END TRY BEGIN CATCH ... END CATCH, THROW / RAISERROR, CREATE [UNIQUE] [CLUSTERED] INDEX.
// The script's result is its last statement when that is a query; otherwise the last table it created or changed.
// Only that final query streams (in parallel) over the datasets; the statements before it run in memory.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace NativeDataEngine
{
    // ---------- statements ----------
    public abstract class Stmt { public string Text; public int Pos; public abstract string Kind { get; } }
    public sealed class QueryS : Stmt
    {
        public QueryStmt Q;
        public override string Kind { get { return "SELECT"; } }
        public bool HasInto { get { SelectStmt s = Q.Body as SelectStmt; return s != null && s.Into != null; } }
    }
    public sealed class ColDef
    {
        public string Name; public DataType Type; public bool NotNull, Pk, Unique, Auto; public string Default, Check;
    }
    public sealed class CreateTableS : Stmt
    {
        public string Name; public bool IfNotExists, OrReplace, Temp; public List<ColDef> Cols = new List<ColDef>();
        public List<string> Pk = new List<string>(); public List<List<string>> Uniques = new List<List<string>>(); public List<string> Checks = new List<string>();
        public string AsQuery;
        public override string Kind { get { return "CREATE TABLE"; } }
    }
    public sealed class CreateViewS : Stmt
    {
        public string Name; public bool OrReplace, IfNotExists; public List<string> Cols; public string QueryText;
        public override string Kind { get { return "CREATE VIEW"; } }
    }
    public sealed class DropS : Stmt
    {
        public string What; public List<string> Names = new List<string>(); public bool IfExists; public string OnTable;
        public override string Kind { get { return "DROP " + What; } }
    }
    public sealed class Assign { public string Col, Expr; }
    public sealed class InsertS : Stmt
    {
        public string Table; public List<string> Cols; public List<List<string>> Rows; public string QueryText; public bool DefaultValues;
        public List<Assign> OnDup; public bool OnConflict; public List<string> ConflictCols; public bool ConflictNothing; public List<Assign> ConflictSets; public string ConflictWhere;
        public bool OrReplace, OrIgnore;
        public override string Kind { get { return "INSERT"; } }
    }
    public sealed class UpdateS : Stmt
    {
        public string Table, Alias, Where, From; public List<Assign> Sets = new List<Assign>();
        public override string Kind { get { return "UPDATE"; } }
    }
    public sealed class DeleteS : Stmt
    {
        public string Table, Alias, Where;
        public override string Kind { get { return "DELETE"; } }
    }
    public sealed class TruncateS : Stmt { public string Table; public override string Kind { get { return "TRUNCATE"; } } }
    public sealed class AlterOp { public string Op; public ColDef Col; public string Name, NewName, Expr; public DataType Type; public List<string> Cols; public bool IfExists, IfNotExists; }
    public sealed class AlterS : Stmt
    {
        public string Table; public List<AlterOp> Ops = new List<AlterOp>();
        public override string Kind { get { return "ALTER TABLE"; } }
    }
    public sealed class MergeWhen { public string Match; public string Cond; public string Action; public List<Assign> Sets; public List<string> InsCols; public List<string> InsVals; }
    public sealed class MergeS : Stmt
    {
        public string Target, TAlias, Source, SAlias, On; public List<MergeWhen> Whens = new List<MergeWhen>();
        public override string Kind { get { return "MERGE"; } }
    }
    public sealed class TxS : Stmt { public string What; public override string Kind { get { return What; } } }
    public sealed class TryS : Stmt { public List<Stmt> Try = new List<Stmt>(), Catch = new List<Stmt>(); public override string Kind { get { return "TRY/CATCH"; } } }
    public sealed class IndexS : Stmt
    {
        public string Name, Table; public bool Unique, Clustered, IfNotExists; public List<string> Cols = new List<string>();
        public override string Kind { get { return "CREATE INDEX"; } }
    }
    public sealed class ThrowS : Stmt { public string Message; public override string Kind { get { return "THROW"; } } }
    public sealed class NoopS : Stmt { public string What; public override string Kind { get { return What; } } }

    // ---------- statement parser ----------
    public sealed partial class Parser
    {
        static readonly HashSet<string> StmtWords = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "SELECT", "WITH", "FROM", "VALUES", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "TRUNCATE", "MERGE", "BEGIN", "START",
            "COMMIT", "ROLLBACK", "THROW", "RAISERROR", "GO", "PRINT", "SET", "USE", "DESCRIBE", "END", "REPLACE" };

        public static List<Stmt> ParseScript(string sql)
        {
            Parser ps = new Parser(sql);
            List<Stmt> r = ps.Statements(null);
            if (ps.Cur.T != Tk.End) throw ps.Err("Unexpected " + ps.Cur);
            return r;
        }
        // Statements until the end, or until END <block> (TRY / CATCH).
        List<Stmt> Statements(string block)
        {
            List<Stmt> r = new List<Stmt>();
            while (true)
            {
                while (AcceptOp(";")) { }
                if (Cur.T == Tk.End) { if (block != null) throw Err("Missing END " + block); break; }
                if (block != null && IsKw("END") && IsKwAt(1, block)) break;
                r.Add(Statement());
                if (!IsOp(";") && Cur.T != Tk.End && !StatementStart()) throw Err("Expected ; between statements but found " + Cur);
            }
            return r;
        }
        bool StatementStart() { return (Cur.T == Tk.Ident && StmtWords.Contains(Cur.V)) || IsOp("("); }
        string Slice(int a, int b)
        {
            int from = t[a].Pos, to = t[Math.Min(b, t.Count - 1)].Pos;
            return src.Substring(from, to - from).Trim();
        }
        string ExprText() { int a = p; Expression(); return Slice(a, p); }
        string QueryText() { int a = p; Query(); return Slice(a, p); }
        List<string> NameList()
        {
            List<string> r = new List<string>();
            ExpectOp("(");
            do { r.Add(Name()); if (!Accept("ASC")) Accept("DESC"); } while (AcceptOp(","));
            ExpectOp(")");
            return r;
        }
        List<Assign> Assignments()
        {
            List<Assign> r = new List<Assign>();
            do
            {
                Assign a = new Assign(); a.Col = Name();
                while (IsOp(".") && (Peek(1).T == Tk.Ident || Peek(1).T == Tk.QIdent)) { p++; a.Col = Name(); }   // t.col -> col
                ExpectOp("=");
                if (IsKw("DEFAULT") && (Peek(1).T == Tk.End || Peek(1).V == "," || Peek(1).V == ";" || IsKwAt(1, "WHERE") || IsKwAt(1, "WHEN") || IsKwAt(1, "FROM"))) { p++; a.Expr = null; }
                else a.Expr = ExprText();
                r.Add(a);
            } while (AcceptOp(","));
            return r;
        }
        bool IfExists() { if (IsKw("IF") && IsKwAt(1, "EXISTS")) { p += 2; return true; } return false; }
        bool IfNotExists() { if (IsKw("IF") && IsKwAt(1, "NOT") && IsKwAt(2, "EXISTS")) { p += 3; return true; } return false; }
        void SkipBalanced()
        {
            ExpectOp("("); int depth = 1;
            while (depth > 0) { if (Cur.T == Tk.End) throw Err("Missing )"); if (IsOp("(")) depth++; else if (IsOp(")")) depth--; p++; }
        }
        // Skips to the next ',' or ')' at this level (FOREIGN KEY ... REFERENCES ... ON DELETE ...).
        void SkipClause()
        {
            int depth = 0;
            while (Cur.T != Tk.End && !(depth == 0 && (IsOp(",") || IsOp(")") || IsOp(";")))) { if (IsOp("(")) depth++; else if (IsOp(")")) depth--; p++; }
        }

        Stmt Statement()
        {
            int start = p;
            Stmt st = Statement0();
            st.Pos = t[start].Pos; st.Text = Slice(start, p);
            return st;
        }
        Stmt Statement0()
        {
            if (IsKw("SELECT") || IsKw("WITH") || IsKw("FROM") || IsKw("VALUES") || IsOp("(")) { QueryS q = new QueryS(); q.Q = Query(); return q; }
            if (IsKw("DESCRIBE")) { p++; QueryS q = new QueryS(); q.Q = Query(); q.Q.Describe = true; return q; }
            if (IsKw("CREATE")) return CreateP();
            if (IsKw("DROP")) return DropP();
            if (IsKw("INSERT") || (IsKw("REPLACE") && IsKwAt(1, "INTO"))) return InsertP();
            if (IsKw("UPDATE")) return UpdateP();
            if (IsKw("DELETE")) return DeleteP();
            if (IsKw("TRUNCATE")) { p++; Accept("TABLE"); TruncateS s = new TruncateS(); s.Table = TableName(); return s; }
            if (IsKw("ALTER")) return AlterP();
            if (IsKw("MERGE")) return MergeP();
            if (IsKw("BEGIN"))
            {
                if (IsKwAt(1, "TRY")) return TryP();
                if (IsKwAt(1, "TRANSACTION") || IsKwAt(1, "TRAN") || IsKwAt(1, "WORK"))
                {
                    p += 2;
                    if (Cur.T == Tk.Ident && !StmtWords.Contains(Cur.V)) p++;   // transaction name
                    return Tx("BEGIN");
                }
                if (Peek(1).T == Tk.End || Peek(1).V == ";") { p++; return Tx("BEGIN"); }
                throw Err("BEGIN ... END blocks are not supported; use BEGIN TRANSACTION or BEGIN TRY");
            }
            if (IsKw("START") && IsKwAt(1, "TRANSACTION")) { p += 2; return Tx("BEGIN"); }
            if (IsKw("COMMIT") || IsKw("ROLLBACK"))
            {
                string w = t[p++].V.ToUpperInvariant();
                if (Accept("TRANSACTION") || Accept("TRAN") || Accept("WORK")) { if (Cur.T == Tk.Ident && !StmtWords.Contains(Cur.V)) p++; }
                return Tx(w);
            }
            if (IsKw("THROW"))
            {
                p++; ThrowS th = new ThrowS();
                if (Cur.T == Tk.End || IsOp(";") || IsKw("END")) return th;   // re-throw inside CATCH
                Expression(); ExpectOp(",");
                Expr m = Expression(); Lit ml = m as Lit; th.Message = ml != null && ml.Value != null ? Convert.ToString(ml.Value, CultureInfo.InvariantCulture) : "Error";
                ExpectOp(","); Expression();
                return th;
            }
            if (IsKw("RAISERROR"))
            {
                p++; ExpectOp("("); ThrowS th = new ThrowS();
                Expr m = Expression(); Lit ml = m as Lit; th.Message = ml != null && ml.Value != null ? Convert.ToString(ml.Value, CultureInfo.InvariantCulture) : "Error";
                while (AcceptOp(",")) Expression();
                ExpectOp(")");
                if (Accept("WITH")) { do { Name(); } while (AcceptOp(",")); }
                return th;
            }
            if (IsKw("GO") || IsKw("PRINT") || IsKw("SET") || IsKw("USE"))
            {
                NoopS n = new NoopS(); n.What = t[p].V.ToUpperInvariant(); int st = p; p++;
                if (n.What == "PRINT") Expression();
                else while (Cur.T != Tk.End && !IsOp(";") && !(p > st + 1 && StatementStart() && !IsKw("SET"))) p++;
                return n;
            }
            throw Err("Unknown statement " + Cur);
        }
        TxS Tx(string w) { TxS s = new TxS(); s.What = w; return s; }

        Stmt CreateP()
        {
            p++;
            bool orReplace = false;
            if (Accept("OR")) { if (!Accept("REPLACE")) Expect("ALTER"); orReplace = true; }
            bool temp = Accept("TEMPORARY") || Accept("TEMP");
            bool unique = Accept("UNIQUE"), clustered = Accept("CLUSTERED");
            if (!clustered) Accept("NONCLUSTERED");
            if (Accept("TABLE")) { CreateTableS ct = CreateTableP(orReplace); ct.Temp = temp; return ct; }
            if (Accept("VIEW"))
            {
                CreateViewS v = new CreateViewS(); v.OrReplace = orReplace; v.IfNotExists = IfNotExists(); v.Name = TableName();
                if (IsOp("(")) { v.Cols = new List<string>(); p++; do { v.Cols.Add(Name()); } while (AcceptOp(",")); ExpectOp(")"); }
                Expect("AS"); v.QueryText = QueryText();
                return v;
            }
            if (Accept("INDEX"))
            {
                IndexS x = new IndexS(); x.Unique = unique; x.Clustered = clustered; x.IfNotExists = IfNotExists();
                x.Name = Name(); Expect("ON"); x.Table = TableName(); x.Cols = NameList();
                if (Accept("INCLUDE")) NameList();
                if (Accept("WHERE")) Expression();
                if (IsKw("WITH") && Peek(1).V == "(") { p++; SkipBalanced(); }
                return x;
            }
            throw Err("Expected TABLE, VIEW or INDEX after CREATE");
        }
        CreateTableS CreateTableP(bool orReplace)
        {
            CreateTableS c = new CreateTableS(); c.OrReplace = orReplace; c.IfNotExists = IfNotExists(); c.Name = TableName();
            if (Accept("AS")) { c.AsQuery = QueryText(); return c; }
            ExpectOp("(");
            do
            {
                if (Accept("CONSTRAINT")) Name();
                if (IsKw("PRIMARY")) { p++; Expect("KEY"); c.Pk = NameList(); }
                else if (IsKw("UNIQUE") && (Peek(1).V == "(" || IsKwAt(1, "KEY") || IsKwAt(1, "INDEX"))) { p++; if (!Accept("KEY")) Accept("INDEX"); if (Cur.T == Tk.Ident && Peek(1).V == "(") p++; c.Uniques.Add(NameList()); }
                else if (IsKw("CHECK")) { p++; ExpectOp("("); c.Checks.Add(ExprText()); ExpectOp(")"); }
                else if (IsKw("FOREIGN") || ((IsKw("INDEX") || IsKw("KEY")) && Peek(1).T != Tk.Op)) SkipClause();
                else c.Cols.Add(ColDefP());
            } while (AcceptOp(","));
            ExpectOp(")");
            while (Cur.T != Tk.End && !IsOp(";") && !StatementStart()) p++;   // table options (ENGINE=..., WITH (...))
            foreach (ColDef d in c.Cols) { if (d.Pk) c.Pk = new List<string> { d.Name }; if (d.Unique) c.Uniques.Add(new List<string> { d.Name }); if (d.Check != null) c.Checks.Add(d.Check); }
            return c;
        }
        ColDef ColDefP()
        {
            ColDef d = new ColDef(); d.Name = Name();
            if (IsKw("SERIAL") || IsKw("BIGSERIAL") || IsKw("SMALLSERIAL")) { d.Type = IsKw("BIGSERIAL") ? DataType.BigInt : DataType.Integer; d.Auto = true; d.NotNull = true; p++; }
            else
            {
                d.Type = ColType();
            }
            while (true)
            {
                if (Accept("CONSTRAINT")) { Name(); continue; }
                if (IsKw("PRIMARY")) { p++; Expect("KEY"); if (!Accept("ASC")) Accept("DESC"); d.Pk = true; d.NotNull = true; if (Accept("AUTOINCREMENT") || Accept("AUTO_INCREMENT")) d.Auto = true; continue; }
                if (IsKw("NOT") && IsKwAt(1, "NULL")) { p += 2; d.NotNull = true; continue; }
                if (Accept("NULL")) continue;
                if (Accept("UNIQUE")) { Accept("KEY"); d.Unique = true; continue; }
                if (Accept("DEFAULT")) { d.Default = Cur.T == Tk.Op && Cur.V == "(" ? ExprText() : PrimaryText(); continue; }
                if (Accept("AUTO_INCREMENT") || Accept("AUTOINCREMENT")) { d.Auto = true; continue; }
                if (Accept("IDENTITY")) { if (IsOp("(")) SkipBalanced(); d.Auto = true; d.NotNull = true; continue; }
                if (IsKw("GENERATED")) { while (!IsKw("IDENTITY") && Cur.T != Tk.End) p++; p++; if (IsOp("(")) SkipBalanced(); d.Auto = true; d.NotNull = true; continue; }
                if (Accept("REFERENCES"))
                {
                    TableName(); if (IsOp("(")) SkipBalanced();
                    while (IsKw("ON") && (IsKwAt(1, "DELETE") || IsKwAt(1, "UPDATE"))) { p += 2; if (Accept("SET")) Name(); else if (Accept("NO")) Name(); else Name(); }
                    continue;
                }
                if (Accept("CHECK")) { ExpectOp("("); d.Check = ExprText(); ExpectOp(")"); continue; }
                if (Accept("COLLATE")) { Name(); continue; }
                if (Accept("COMMENT")) { p++; continue; }
                if (Accept("UNSIGNED") || Accept("SIGNED")) continue;
                break;
            }
            return d;
        }
        // A DEFAULT value: a literal (with sign), a name, a function call or a parenthesised expression.
        string PrimaryText() { int a = p; Unary(); return Slice(a, p); }
        DataType ColType()
        {
            string n = Name();
            if (IsKw("VARYING")) p++;   // CHARACTER VARYING
            if (IsKw("PRECISION")) p++;
            if (IsKw("WITH") && IsKwAt(1, "TIME")) { p += 3; Accept("ZONE"); }
            if (IsKw("WITHOUT") && IsKwAt(1, "TIME")) { p += 3; Accept("ZONE"); }
            StringBuilder sb = new StringBuilder(n);
            if (IsOp("("))
            {
                p++; sb.Append('(');
                do { sb.Append(t[p++].V); if (IsOp(",")) sb.Append(','); } while (AcceptOp(","));
                ExpectOp(")"); sb.Append(')');
            }
            DataType dt = DataType.TryParse(sb.ToString()) ?? DataType.TryParse(n) ?? ExtraType(n);
            if (dt == null) throw Err("Unknown column type " + sb);
            return dt;
        }
        static DataType ExtraType(string n)
        {
            switch (n.ToUpperInvariant())
            {
                case "DATETIME2": case "SMALLDATETIME": case "DATETIMEOFFSET": return DataType.Timestamp;
                case "MONEY": return DataType.Decimal(19, 4);
                case "SMALLMONEY": return DataType.Decimal(10, 4);
                case "BIT": return DataType.Bool;
                case "NCHAR": case "CHARACTER": case "NTEXT": case "CLOB": case "TINYTEXT": case "MEDIUMTEXT": case "LONGTEXT": case "VARCHAR2": case "NVARCHAR2": case "CITEXT": return DataType.Varchar;
                case "MEDIUMINT": return DataType.Integer;
                case "NUMBER": return DataType.Decimal(18, 3);
            }
            return null;
        }

        Stmt DropP()
        {
            p++; DropS d = new DropS();
            if (Accept("TABLE")) d.What = "TABLE"; else if (Accept("VIEW")) d.What = "VIEW"; else if (Accept("INDEX")) d.What = "INDEX";
            else throw Err("Expected TABLE, VIEW or INDEX after DROP");
            d.IfExists = IfExists();
            do { d.Names.Add(TableName()); } while (AcceptOp(","));
            if (d.What == "INDEX" && Accept("ON")) d.OnTable = TableName();
            if (!Accept("CASCADE")) Accept("RESTRICT");
            return d;
        }
        Stmt InsertP()
        {
            InsertS s = new InsertS();
            if (Accept("REPLACE")) s.OrReplace = true;
            else
            {
                p++;
                if (Accept("OR")) { if (Accept("REPLACE")) s.OrReplace = true; else { Expect("IGNORE"); s.OrIgnore = true; } }
                if (Accept("IGNORE")) s.OrIgnore = true;
            }
            Accept("INTO");
            s.Table = TableName();
            if (IsOp("(") && !IsKwAt(1, "SELECT") && !IsKwAt(1, "WITH")) { p++; s.Cols = new List<string>(); do { s.Cols.Add(Name()); } while (AcceptOp(",")); ExpectOp(")"); }
            if (IsKw("DEFAULT") && IsKwAt(1, "VALUES")) { p += 2; s.DefaultValues = true; }
            else if (Accept("VALUES") || Accept("VALUE")) s.Rows = ValueRows();
            else if (Accept("SET"))
            {
                List<Assign> a = Assignments();
                s.Cols = a.Select(x => x.Col).ToList(); s.Rows = new List<List<string>> { a.Select(x => x.Expr).ToList() };
            }
            else s.QueryText = QueryText();
            if (IsKw("ON") && IsKwAt(1, "DUPLICATE")) { p += 2; Expect("KEY"); Expect("UPDATE"); s.OnDup = Assignments(); }
            else if (IsKw("ON") && IsKwAt(1, "CONFLICT"))
            {
                p += 2; s.OnConflict = true;
                if (IsOp("(")) s.ConflictCols = NameList();
                Expect("DO");
                if (Accept("NOTHING")) s.ConflictNothing = true;
                else { Expect("UPDATE"); Expect("SET"); s.ConflictSets = Assignments(); if (Accept("WHERE")) s.ConflictWhere = ExprText(); }
            }
            return s;
        }
        List<List<string>> ValueRows()
        {
            List<List<string>> rows = new List<List<string>>();
            do
            {
                ExpectOp("(");
                List<string> row = new List<string>();
                do { if (IsKw("DEFAULT") && (Peek(1).V == "," || Peek(1).V == ")")) { p++; row.Add(null); } else row.Add(ExprText()); } while (AcceptOp(","));
                ExpectOp(")");
                rows.Add(row);
            } while (AcceptOp(","));
            return rows;
        }
        string AliasP(params string[] stop)
        {
            if (Accept("AS")) return Name();
            if ((Cur.T == Tk.Ident && !Reserved.Contains(Cur.V) && !stop.Any(x => string.Equals(x, Cur.V, StringComparison.OrdinalIgnoreCase))) || Cur.T == Tk.QIdent) return Name();
            return null;
        }
        Stmt UpdateP()
        {
            p++; UpdateS u = new UpdateS(); u.Table = TableName(); u.Alias = AliasP("SET");
            Expect("SET"); u.Sets = Assignments();
            if (Accept("FROM")) { int a = p; FromList(); u.From = Slice(a, p); }
            if (Accept("WHERE")) u.Where = ExprText();
            return u;
        }
        Stmt DeleteP()
        {
            p++; DeleteS d = new DeleteS(); Accept("FROM"); d.Table = TableName(); d.Alias = AliasP("WHERE");
            if (Accept("WHERE")) d.Where = ExprText();
            return d;
        }
        Stmt AlterP()
        {
            p++; Expect("TABLE"); IfExists();
            AlterS a = new AlterS(); a.Table = TableName();
            do
            {
                AlterOp o = new AlterOp();
                if (Accept("ADD"))
                {
                    if (Accept("CONSTRAINT")) o.Name = Name();
                    if (IsKw("PRIMARY")) { p++; Expect("KEY"); o.Op = "ADD PRIMARY KEY"; o.Cols = NameList(); }
                    else if (IsKw("UNIQUE")) { p++; if (!Accept("KEY")) Accept("INDEX"); o.Op = "ADD UNIQUE"; o.Cols = NameList(); }
                    else if (IsKw("CHECK")) { p++; ExpectOp("("); o.Op = "ADD CHECK"; o.Expr = ExprText(); ExpectOp(")"); }
                    else if (IsKw("FOREIGN")) { SkipClause(); o.Op = "NOOP"; }
                    else if (IsOp("("))
                    {
                        p++;
                        do { AlterOp x = new AlterOp(); x.Op = "ADD COLUMN"; x.Col = ColDefP(); a.Ops.Add(x); } while (AcceptOp(","));
                        ExpectOp(")"); continue;
                    }
                    else { Accept("COLUMN"); o.IfNotExists = IfNotExists(); o.Op = "ADD COLUMN"; o.Col = ColDefP(); }
                }
                else if (Accept("DROP"))
                {
                    if (Accept("CONSTRAINT")) { o.IfExists = IfExists(); o.Op = "DROP CONSTRAINT"; o.Name = Name(); }
                    else if (IsKw("PRIMARY")) { p++; Expect("KEY"); o.Op = "DROP PRIMARY KEY"; }
                    else { Accept("COLUMN"); o.IfExists = IfExists(); o.Op = "DROP COLUMN"; o.Name = Name(); }
                }
                else if (Accept("MODIFY")) { Accept("COLUMN"); o.Op = "MODIFY COLUMN"; o.Col = ColDefP(); }
                else if (Accept("CHANGE")) { Accept("COLUMN"); o.Op = "CHANGE COLUMN"; o.Name = Name(); o.Col = ColDefP(); }
                else if (Accept("ALTER"))
                {
                    Accept("COLUMN"); o.Name = Name();
                    if (Accept("TYPE")) { o.Op = "SET TYPE"; o.Type = ColType(); }
                    else if (IsKw("SET") && IsKwAt(1, "DATA")) { p += 2; Expect("TYPE"); o.Op = "SET TYPE"; o.Type = ColType(); }
                    else if (IsKw("SET") && IsKwAt(1, "DEFAULT")) { p += 2; o.Op = "SET DEFAULT"; o.Expr = PrimaryText(); }
                    else if (IsKw("DROP") && IsKwAt(1, "DEFAULT")) { p += 2; o.Op = "DROP DEFAULT"; }
                    else if (IsKw("SET") && IsKwAt(1, "NOT")) { p += 3; o.Op = "SET NOT NULL"; }
                    else if (IsKw("DROP") && IsKwAt(1, "NOT")) { p += 3; o.Op = "DROP NOT NULL"; }
                    else
                    {
                        // SQL Server: ALTER COLUMN c type [NULL | NOT NULL]
                        o.Op = "SET TYPE"; o.Type = ColType();
                        if (IsKw("NOT") && IsKwAt(1, "NULL")) { p += 2; AlterOp nn = new AlterOp(); nn.Op = "SET NOT NULL"; nn.Name = o.Name; a.Ops.Add(o); o = nn; }
                        else Accept("NULL");
                    }
                }
                else if (Accept("RENAME"))
                {
                    if (Accept("TO") || Accept("AS")) { o.Op = "RENAME TO"; o.NewName = TableName(); }
                    else { Accept("COLUMN"); o.Op = "RENAME COLUMN"; o.Name = Name(); Expect("TO"); o.NewName = Name(); }
                }
                else throw Err("Expected ADD, DROP, MODIFY, ALTER or RENAME in ALTER TABLE");
                a.Ops.Add(o);
            } while (AcceptOp(","));
            return a;
        }
        Stmt MergeP()
        {
            p++; Accept("INTO");
            MergeS m = new MergeS(); m.Target = TableName(); m.TAlias = AliasP("USING");
            Expect("USING");
            int a = p;
            if (IsOp("(")) { p++; Query(); ExpectOp(")"); m.Source = Slice(a, p); }
            else { string n = TableName(); m.Source = "\"" + n.Replace("\"", "\"\"") + "\""; if (m.SAlias == null) m.SAlias = n; }
            string al = AliasP("ON"); if (al != null) m.SAlias = al;
            if (m.SAlias == null) throw Err("MERGE ... USING (subquery) needs an alias");
            Expect("ON"); m.On = ExprText();
            while (Accept("WHEN"))
            {
                MergeWhen w = new MergeWhen();
                if (Accept("NOT")) { Expect("MATCHED"); w.Match = "NOT MATCHED"; if (Accept("BY")) { if (Accept("SOURCE")) w.Match = "NOT MATCHED BY SOURCE"; else Expect("TARGET"); } }
                else { Expect("MATCHED"); w.Match = "MATCHED"; }
                if (Accept("AND")) w.Cond = ExprText();
                Expect("THEN");
                if (Accept("UPDATE")) { Expect("SET"); w.Action = "UPDATE"; w.Sets = Assignments(); }
                else if (Accept("DELETE")) w.Action = "DELETE";
                else if (Accept("INSERT"))
                {
                    w.Action = "INSERT";
                    if (IsOp("(")) { p++; w.InsCols = new List<string>(); do { w.InsCols.Add(Name()); } while (AcceptOp(",")); ExpectOp(")"); }
                    if (IsKw("DEFAULT") && IsKwAt(1, "VALUES")) { p += 2; w.InsVals = new List<string>(); }
                    else { Expect("VALUES"); List<List<string>> rows = ValueRows(); if (rows.Count != 1) throw Err("MERGE INSERT takes one row of VALUES"); w.InsVals = rows[0]; }
                }
                else if (Accept("DO")) { Expect("NOTHING"); w.Action = "NOTHING"; }
                else throw Err("Expected UPDATE, DELETE or INSERT after THEN");
                if (w.Match == "NOT MATCHED" && w.Action != "INSERT" && w.Action != "NOTHING") throw Err("WHEN NOT MATCHED can only INSERT");
                if (w.Match != "NOT MATCHED" && w.Action == "INSERT") throw Err("Only WHEN NOT MATCHED can INSERT");
                m.Whens.Add(w);
            }
            if (m.Whens.Count == 0) throw Err("MERGE needs at least one WHEN clause");
            return m;
        }
        Stmt TryP()
        {
            p += 2; TryS s = new TryS();
            s.Try = Statements("TRY"); p += 2;
            Expect("BEGIN"); Expect("CATCH");
            s.Catch = Statements("CATCH"); p += 2;
            return s;
        }
    }

    // ---------- execution ----------
    public sealed partial class DataEngine
    {
        public sealed class SessTable
        {
            public string Name; public Schema Schema; public long Rows, Bytes;
            // Rows live in memory (mem) or, once memory ran short while the table was built, in Arrow parts on disk
            // (Files, under temp\spill). Queries and writes stream a spilled table from disk (Open); statements that
            // change rows read it back into memory (Batches).
            List<Batch> mem = new List<Batch>();
            public List<string> Files;
            public List<Batch> Batches
            {
                get
                {
                    if (Files == null) return mem;
                    List<Batch> l = new List<Batch>();
                    Source src = DataFiles.Open(Files);
                    int n = src.Units(null);
                    for (int u = 0; u < n; u++) foreach (Batch b in src.RunUnit(null, u)) l.Add(new Batch(Schema, b.Cols, b.Rows));
                    return l;
                }
                set { mem = value; Files = null; }
            }
            public Source Open() { return Files != null ? DataFiles.Open(Files) : new MemSource(Schema, mem); }
            public void ShareRows(SessTable t) { mem = t.mem; Files = t.Files; Rows = t.Rows; Bytes = t.Bytes; }
            public List<string> Pk = new List<string>(); public List<List<string>> Uniques = new List<List<string>>();
            public HashSet<string> NotNull = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public Dictionary<string, string> Defaults = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            public List<string> Checks = new List<string>();
            public string AutoCol;
            public SessTable CopyMeta()
            {
                SessTable t = new SessTable(); t.Name = Name; t.Schema = Schema;
                t.Pk = new List<string>(Pk); t.Uniques = Uniques.Select(u => new List<string>(u)).ToList();
                t.NotNull = new HashSet<string>(NotNull, StringComparer.OrdinalIgnoreCase);
                t.Defaults = new Dictionary<string, string>(Defaults, StringComparer.OrdinalIgnoreCase);
                t.Checks = new List<string>(Checks); t.AutoCol = AutoCol;
                return t;
            }
            public bool Has(string col) { return Schema.IndexOf(col) >= 0; }
            public string Col(string col)
            {
                int i = Schema.IndexOf(col);
                if (i < 0) throw new EngineException("COLUMN_NOT_FOUND", "Table \"" + Name + "\" has no column \"" + col + "\". Columns: " + string.Join(", ", Schema.Fields.Select(f => f.Name)) + ".");
                return Schema[i].Name;
            }
        }
        internal sealed class IndexDef { public string Name, Table; public List<string> Cols; public bool Unique, Clustered; }

        public sealed class ScriptSession : IDisposable
        {
            internal readonly Dictionary<string, SessTable> Tables = new Dictionary<string, SessTable>(StringComparer.OrdinalIgnoreCase);
            internal readonly Dictionary<string, string> Views = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            internal readonly Dictionary<string, IndexDef> Indexes = new Dictionary<string, IndexDef>(StringComparer.OrdinalIgnoreCase);
            internal readonly List<MemoryLease> Leases = new List<MemoryLease>();
            internal readonly HashSet<string> Dropped = new HashSet<string>(StringComparer.OrdinalIgnoreCase);   // datasets dropped by the script
            internal string Sql, LastTable;
            internal readonly List<string> Outputs = new List<string>();   // CREATE TABLE (not TEMP) names, in order: saved by WriteTables
            internal Snapshot Tx; internal int TxDepth;
            internal EngineException CatchErr;
            internal Catalog Cat;
            internal int Seq;
            internal readonly List<string> Spills = new List<string>();
            internal Job Job;   // set by WriteTables: rows read count toward its progress   // spill folders of tables that went to disk
            public void Dispose()
            {
                foreach (MemoryLease l in Leases) l.Dispose(); Leases.Clear(); Tables.Clear();
                foreach (string d in Spills) { DataFiles.Forget(d); DatasetWriter.TryDelete(d); }
                Spills.Clear();
            }
        }
        internal sealed class Snapshot
        {
            public Dictionary<string, SessTable> Tables; public Dictionary<string, string> Views; public Dictionary<string, IndexDef> Indexes; public string LastTable;
        }

        // Splits sql into statements; a plain single query is returned as is (no session). Otherwise every statement
        // before the final query runs now, and the final query is returned to be planned with the session catalog.
        // job (optional): the script's reads count toward its rows processed (WriteTables progress).
        QueryStmt Prepare(string sql, Dictionary<string, string> views, out Catalog cat, CancellationToken ct, Job job = null)
        {
            List<Stmt> stmts = Parser.ParseScript(sql);
            if (stmts.Count == 0) throw new EngineException("SQL_SYNTAX", "The query is empty.");
            cat = new Catalog(this, views);
            QueryS only = stmts.Count == 1 ? stmts[0] as QueryS : null;
            if (only != null && !only.HasInto) return only.Q;
            ScriptSession s = new ScriptSession(); s.Sql = sql; s.Cat = cat; cat.Session = s; s.Job = job;
            try { return RunScript(s, stmts, ct); }
            catch { cat.Dispose(); throw; }
        }

        QueryStmt RunScript(ScriptSession s, List<Stmt> stmts, CancellationToken ct)
        {
            int last = stmts.Count - 1;
            QueryS fin = stmts[last] as QueryS;
            bool finalQuery = fin != null && !fin.HasInto;
            for (int i = 0; i < (finalQuery ? last : stmts.Count); i++)
            {
                ct.ThrowIfCancellationRequested();
                try { Exec(s, stmts[i], ct, false); }
                catch (EngineException e)
                {
                    if (e.Code == "SQL_THROW") throw;
                    throw new EngineException(e.Code, "Statement " + (i + 1) + " (" + stmts[i].Kind + ", line " + Line(s.Sql, stmts[i].Pos) + "): " + e.Message, e.Status);
                }
            }
            if (finalQuery) return fin.Q;
            if (s.LastTable != null && (s.Tables.ContainsKey(s.LastTable) || s.Views.ContainsKey(s.LastTable))) return Parser.ParseQuery("SELECT * FROM " + Q(s.LastTable));
            throw new EngineException("SQL_NO_RESULT", "The script ran but has nothing to show: end it with a SELECT (or create or change a table).");
        }
        // Live check for the editor: syntax of the whole script; for a single query also names and types (planned, not
        // run). Returns { errors: [{ pos, end, line, message, code }] } (pos/end: 0-based character offsets, -1 unknown).
        public Dictionary<string, object> Check(string sql, Dictionary<string, string> views)
        {
            List<object> errs = new List<object>();
            if (!string.IsNullOrWhiteSpace(sql))
            {
                try
                {
                    List<Stmt> st = Parser.ParseScript(sql);
                    QueryS only = st.Count == 1 ? st[0] as QueryS : null;
                    if (only != null && !only.HasInto) { Catalog cat = new Catalog(this, views); try { PlanQ(only.Q, cat); } finally { cat.Dispose(); } }
                }
                catch (EngineException ex) { errs.Add(CheckErr(sql, ex)); }
                catch (TypeWidenException) { }
            }
            Dictionary<string, object> r = new Dictionary<string, object>(); r["errors"] = errs;
            return r;
        }
        static Dictionary<string, object> CheckErr(string sql, EngineException ex)
        {
            string msg = ex.Message; int pos = -1;
            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(msg, @" at position (\d+)\.$");
            if (m.Success) { pos = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) - 1; msg = msg.Substring(0, m.Index) + "."; }
            else
            {
                // No position (name / type errors): mark the first whole-word use of the quoted name in the message.
                System.Text.RegularExpressions.Match q = System.Text.RegularExpressions.Regex.Match(msg, "\"([^\"]+)\"");
                if (q.Success)
                {
                    string name = q.Groups[1].Value; int dot = name.LastIndexOf('.'); if (dot >= 0) name = name.Substring(dot + 1);
                    System.Text.RegularExpressions.Match w = System.Text.RegularExpressions.Regex.Match(sql, @"(?<![A-Za-z0-9_])" + System.Text.RegularExpressions.Regex.Escape(name) + @"(?![A-Za-z0-9_])", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                    if (w.Success) pos = w.Index;
                }
            }
            int end = -1;
            if (pos >= sql.Length)
            {
                // "Unexpected end of query": mark the last word.
                pos = Math.Max(0, sql.TrimEnd().Length - 1);
                while (pos > 0 && (char.IsLetterOrDigit(sql[pos - 1]) || sql[pos - 1] == '_')) pos--;
            }
            if (pos >= 0)
            {
                end = pos;
                char c = sql[pos];
                if (char.IsLetterOrDigit(c) || c == '_') while (end < sql.Length && (char.IsLetterOrDigit(sql[end]) || sql[end] == '_' || sql[end] == '$')) end++;
                else if (c == '\'' || c == '"') { end = sql.IndexOf(c, pos + 1); end = end < 0 ? sql.Length : end + 1; }
                else end = pos + 1;
            }
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["pos"] = pos; d["end"] = end; d["line"] = pos >= 0 ? Line(sql, pos) : (object)null; d["message"] = msg; d["code"] = ex.Code;
            return d;
        }
        static int Line(string sql, int pos) { int n = 1; for (int i = 0; i < pos && i < sql.Length; i++) if (sql[i] == '\n') n++; return n; }

        void Exec(ScriptSession s, Stmt st, CancellationToken ct, bool inTry)
        {
            QueryS qs = st as QueryS;
            if (qs != null)
            {
                if (qs.HasInto)
                {
                    SelectStmt sel = ((SelectStmt)qs.Q.Body).Clone(); string into = sel.Into; sel.Into = null;
                    QueryStmt q = qs.Q.Copy(); q.Body = sel;
                    if (Exists(s, into)) throw new EngineException("TABLE_EXISTS", "Table \"" + into + "\" already exists.");
                    s.Tables[into] = NewTableQ(s, into, q, ct);
                    s.Dropped.Remove(into); s.LastTable = into;
                }
                else if (inTry) RunQ(s, qs.Q, ct);           // inside TRY: run it, so its errors reach CATCH
                else PlanQ(qs.Q, s.Cat);                     // a query that is not the result: checked only
                return;
            }
            if (st is CreateTableS) { CreateTable(s, (CreateTableS)st, ct); return; }
            if (st is CreateViewS) { CreateView(s, (CreateViewS)st); return; }
            if (st is DropS) { Drop(s, (DropS)st); return; }
            if (st is InsertS) { Insert(s, (InsertS)st, ct); return; }
            if (st is UpdateS) { Update(s, (UpdateS)st, ct); return; }
            if (st is DeleteS) { Delete(s, (DeleteS)st, ct); return; }
            if (st is TruncateS) { SessTable t = Get(s, ((TruncateS)st).Table, ct); Put(s, t, t.Schema, new List<Batch>(), ct, false); return; }
            if (st is AlterS) { Alter(s, (AlterS)st, ct); return; }
            if (st is MergeS) { Merge(s, (MergeS)st, ct); return; }
            if (st is IndexS) { CreateIndex(s, (IndexS)st, ct); return; }
            TxS tx = st as TxS;
            if (tx != null)
            {
                if (tx.What == "BEGIN") { if (s.TxDepth == 0) s.Tx = Snap(s); s.TxDepth++; return; }
                if (s.TxDepth == 0) throw new EngineException("SQL_TRANSACTION", tx.What + " has no matching BEGIN TRANSACTION.");
                if (tx.What == "COMMIT") { if (--s.TxDepth == 0) s.Tx = null; return; }
                Restore(s, s.Tx); s.Tx = null; s.TxDepth = 0;   // ROLLBACK undoes the whole transaction
                return;
            }
            TryS ts = st as TryS;
            if (ts != null)
            {
                try { foreach (Stmt x in ts.Try) Exec(s, x, ct, true); }
                catch (EngineException e)
                {
                    EngineException prevErr = s.CatchErr; string prevMsg = Functions.CatchError;
                    s.CatchErr = e; Functions.CatchError = e.Message;
                    try { foreach (Stmt x in ts.Catch) Exec(s, x, ct, true); }
                    finally { s.CatchErr = prevErr; Functions.CatchError = prevMsg; }
                }
                return;
            }
            ThrowS th = st as ThrowS;
            if (th != null)
            {
                if (th.Message == null)
                {
                    if (s.CatchErr == null) throw new EngineException("SQL_THROW", "THROW without arguments is only allowed inside CATCH.");
                    throw s.CatchErr;
                }
                throw new EngineException("SQL_THROW", th.Message);
            }
            if (st is NoopS) return;
            throw new EngineException("SQL_UNSUPPORTED", st.Kind + " is not supported.");
        }

        // ---------- helpers ----------
        sealed class Result { public Schema Schema; public List<Batch> Batches = new List<Batch>(); }
        Result RunQ(ScriptSession s, QueryStmt q, CancellationToken ct)
        {
            Planned p = PlanQ(q, s.Cat);
            ExecCtx ctx = Ctx(s.Job, 0, ct);
            Result r = new Result(); r.Schema = p.Op.Schema;
            try { foreach (Batch b in p.Op.Run(ctx)) if (b.Rows > 0) r.Batches.Add(b); }
            finally { ctx.End(); }
            return r;
        }
        Result Run(ScriptSession s, string sql, CancellationToken ct) { return RunQ(s, Parser.ParseQuery(sql), ct); }
        long Scalar(ScriptSession s, string sql, CancellationToken ct)
        {
            Result r = Run(s, sql, ct);
            foreach (Batch b in r.Batches) if (b.Rows > 0 && !b.Cols[0].IsNull(0)) return Convert.ToInt64(Values.Text(b.Cols[0], 0), CultureInfo.InvariantCulture);
            return 0;
        }
        static Schema Fix(Schema s)
        {
            List<Field> fs = new List<Field>();
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Field f in s.Fields)
            {
                if (!seen.Add(f.Name)) throw new EngineException("SQL_DUPLICATE_COLUMN", "Column \"" + f.Name + "\" appears twice; give one of them an alias.");
                fs.Add(new Field(f.Name, f.Type.Kind == Kind.Null ? DataType.Varchar : f.Type));
            }
            return new Schema(fs);
        }
        static Batch Conform(Batch b, Schema s)
        {
            if (b.Cols.Length != s.Count) throw new EngineException("SQL_COLUMNS", "Expected " + s.Count + " columns but got " + b.Cols.Length + ".");
            Column[] cs = new Column[s.Count];
            for (int k = 0; k < cs.Length; k++)
            {
                Column c = b.Cols[k];
                cs[k] = c.Type.SameAs(s[k].Type) ? c : Cast.To(c, s[k].Type, false);
            }
            return new Batch(s, cs, b.Rows);
        }
        // Builds a session table from rows (streamed: a query's batches arrive one at a time). Held in memory while it
        // fits; when memory runs short (SpillFraction of the budget, or free RAM under the floor) what is held and the
        // rest go to Arrow parts under temp\spill, deleted when the script ends.
        SessTable NewTable(ScriptSession s, string name, Schema schema, IEnumerable<Batch> batches, SessTable meta)
        {
            SessTable t = meta != null ? meta.CopyMeta() : new SessTable();
            t.Name = name; t.Schema = schema;
            MemoryLease l = new MemoryLease(Mem, "Script table " + name); s.Leases.Add(l);
            List<Batch> held = t.Batches;
            DatasetWriter w = null; string dir = null;
            try
            {
                foreach (Batch b in batches)
                {
                    if (b.Rows == 0) continue;
                    Batch c = Conform(b, schema);
                    t.Rows += c.Rows; t.Bytes += c.Bytes;
                    if (w == null && Options.SpillToDisk && (Mem.Reserved + c.Bytes > Mem.Budget * SpillFraction || Mem.LowRam))
                    {
                        dir = Path.Combine(SpillRoot, "script-" + Guid.NewGuid().ToString("N").Substring(0, 8)); s.Spills.Add(dir);
                        w = new DatasetWriter(SpillRoot, dir, schema, true, 0, Options.PartBytes, 0);
                        foreach (Batch h in held) w.Append(ArrowFileWriter.Encode(h));
                        held.Clear(); l.Dispose();
                        EngineLog.Write("engine", "Script table " + name + " spills to disk (" + MemoryGuard.Mb(Mem.AvailPhys) + " free RAM)");
                    }
                    if (w != null) w.Append(ArrowFileWriter.Encode(c));
                    else { held.Add(c); l.Add(c.Bytes); }
                }
                if (w != null) { w.Commit(null); w.Dispose(); w = null; t.Files = Datasets.Files(dir); }
            }
            finally { if (w != null) w.Dispose(); }
            return t;
        }
        // A query's rows, one batch at a time (for NewTable: big results go to disk instead of piling up in memory).
        IEnumerable<Batch> Stream(ScriptSession s, Planned p, CancellationToken ct)
        {
            ExecCtx ctx = Ctx(s.Job, 0, ct);
            try { foreach (Batch b in p.Op.Run(ctx)) if (b.Rows > 0) yield return b; }
            finally { ctx.End(); }
        }
        SessTable NewTableQ(ScriptSession s, string name, QueryStmt q, CancellationToken ct)
        {
            Planned p = PlanQ(q, s.Cat);
            return NewTable(s, name, Fix(p.Op.Schema), Stream(s, p, ct), null);
        }
        // Replaces table t with new rows (and schema), after checking its constraints.
        SessTable Put(ScriptSession s, SessTable meta, Schema schema, List<Batch> rows, CancellationToken ct, bool fillAuto)
        {
            SessTable prev; s.Tables.TryGetValue(meta.Name, out prev);
            SessTable n = NewTable(s, meta.Name, schema, rows, meta);
            s.Tables[n.Name] = n;
            try { CheckTable(s, n, ct); }
            catch { if (prev != null) s.Tables[meta.Name] = prev; else s.Tables.Remove(meta.Name); throw; }
            s.LastTable = n.Name;
            return n;
        }
        bool Exists(ScriptSession s, string name)
        {
            return s.Tables.ContainsKey(name) || s.Views.ContainsKey(name) || (!s.Dropped.Contains(name) && (s.Cat.BaseViewSql(name) != null || tables.ContainsKey(name)));
        }
        // The session table, or a session copy of a dataset / cached table (so changes never touch the files).
        SessTable Get(ScriptSession s, string name, CancellationToken ct)
        {
            SessTable t;
            if (s.Tables.TryGetValue(name, out t)) return t;
            if (s.Views.ContainsKey(name)) throw new EngineException("SQL_VIEW_READONLY", "\"" + name + "\" is a view; change the tables it reads instead.");
            if (!Exists(s, name)) throw new EngineException("TABLE_NOT_FOUND", "Table \"" + name + "\" not found.");
            t = NewTableQ(s, name, Parser.ParseQuery("SELECT * FROM " + Q(name)), ct);
            s.Tables[name] = t;
            return t;
        }
        static string TypeSql(DataType t) { return t.Kind == Kind.Null ? "VARCHAR" : t.Name; }
        static string CastSql(string expr, DataType t) { return "CAST((" + expr + ") AS " + TypeSql(t) + ")"; }
        string DefaultSql(SessTable t, string col) { string d; return t.Defaults.TryGetValue(col, out d) ? d : "NULL"; }
        static string Key(Batch b, int[] cols, int i)
        {
            StringBuilder sb = new StringBuilder();
            foreach (int c in cols) { string v = Values.Text(b.Cols[c], i); if (v == null) return null; sb.Append(v).Append('\u0001'); }
            return sb.ToString();
        }
        static int[] Idx(SessTable t, List<string> cols) { return cols.Select(c => t.Schema.IndexOf(c)).ToArray(); }

        // NOT NULL, PRIMARY KEY / UNIQUE (NULLs allowed in UNIQUE), CHECK.
        void CheckTable(ScriptSession s, SessTable t, CancellationToken ct)
        {
            List<string> nn = new List<string>(t.NotNull); nn.AddRange(t.Pk);
            foreach (string c in nn.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                int k = t.Schema.IndexOf(c); if (k < 0) continue;
                if (c.Equals(t.AutoCol, StringComparison.OrdinalIgnoreCase)) continue;
                foreach (Batch b in t.Batches) for (int i = 0; i < b.Rows; i++) if (b.Cols[k].IsNull(i))
                            throw new EngineException("CONSTRAINT_NOT_NULL", "Column \"" + t.Schema[k].Name + "\" of table \"" + t.Name + "\" can't be NULL.");
            }
            List<List<string>> keys = new List<List<string>>();
            if (t.Pk.Count > 0) keys.Add(t.Pk);
            keys.AddRange(t.Uniques);
            foreach (List<string> key in keys)
            {
                int[] idx = Idx(t, key); if (idx.Any(i => i < 0)) continue;
                HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (Batch b in t.Batches)
                    for (int i = 0; i < b.Rows; i++)
                    {
                        string kv = Key(b, idx, i);
                        if (kv != null && !seen.Add(kv))
                            throw new EngineException("CONSTRAINT_UNIQUE", "Duplicate key in table \"" + t.Name + "\": (" + string.Join(", ", key) + ") = (" + kv.TrimEnd('\u0001').Replace("\u0001", ", ") + ").");
                    }
            }
            foreach (string chk in t.Checks)
                if (Scalar(s, "SELECT count(*) FROM " + Q(t.Name) + " WHERE NOT coalesce((" + chk + "), TRUE)", ct) > 0)
                    throw new EngineException("CONSTRAINT_CHECK", "A row of table \"" + t.Name + "\" breaks the CHECK (" + chk + ").");
        }
        static void FillAuto(SessTable t, List<Batch> existing, List<Batch> rows)
        {
            if (t.AutoCol == null) return;
            int k = t.Schema.IndexOf(t.AutoCol); if (k < 0) return;
            long next = 1;
            foreach (Batch b in existing.Concat(rows)) for (int i = 0; i < b.Rows; i++) if (!b.Cols[k].IsNull(i)) next = Math.Max(next, Convert.ToInt64(Values.Text(b.Cols[k], i), CultureInfo.InvariantCulture) + 1);
            for (int r = 0; r < rows.Count; r++)
            {
                Batch b = rows[r]; Column c = b.Cols[k];
                bool any = false; for (int i = 0; i < b.Rows; i++) if (c.IsNull(i)) any = true;
                if (!any) continue;
                Column n = Cast.To(c, DataType.BigInt, false);
                Column o = new Column(DataType.BigInt, b.Rows);
                for (int i = 0; i < b.Rows; i++) o.I[i] = n.IsNull(i) ? next++ : n.I[i];
                Column[] cs = (Column[])b.Cols.Clone(); cs[k] = Cast.To(o, t.Schema[k].Type, false);
                rows[r] = new Batch(b.Schema, cs, b.Rows);
            }
        }
        Snapshot Snap(ScriptSession s)
        {
            Snapshot x = new Snapshot();
            x.Tables = new Dictionary<string, SessTable>(s.Tables, StringComparer.OrdinalIgnoreCase);
            x.Views = new Dictionary<string, string>(s.Views, StringComparer.OrdinalIgnoreCase);
            x.Indexes = new Dictionary<string, IndexDef>(s.Indexes, StringComparer.OrdinalIgnoreCase);
            x.LastTable = s.LastTable;
            return x;
        }
        static void Restore(ScriptSession s, Snapshot x)
        {
            s.Tables.Clear(); foreach (KeyValuePair<string, SessTable> kv in x.Tables) s.Tables[kv.Key] = kv.Value;
            s.Views.Clear(); foreach (KeyValuePair<string, string> kv in x.Views) s.Views[kv.Key] = kv.Value;
            s.Indexes.Clear(); foreach (KeyValuePair<string, IndexDef> kv in x.Indexes) s.Indexes[kv.Key] = kv.Value;
            s.LastTable = x.LastTable;
        }

        // Rewrites column references in an assignment / condition: VALUES(c) and EXCLUDED.c -> newAlias.c,
        // table.c / alias.c / c (a column of t) -> oldAlias.c.
        static string RewriteRefs(string text, SessTable t, IEnumerable<string> ownNames, string oldAlias, string newAlias)
        {
            List<Token> tk = Lexer.Run(text);
            StringBuilder sb = new StringBuilder();
            HashSet<string> own = new HashSet<string>(ownNames.Where(x => x != null), StringComparer.OrdinalIgnoreCase);
            Func<int, bool> isName = i => i < tk.Count && (tk[i].T == Tk.Ident || tk[i].T == Tk.QIdent);
            Func<int, string, bool> isOp = (i, o) => i < tk.Count && tk[i].T == Tk.Op && tk[i].V == o;
            int k = 0;
            while (k < tk.Count && tk[k].T != Tk.End)
            {
                Token x = tk[k];
                if (newAlias != null && x.T == Tk.Ident && string.Equals(x.V, "VALUES", StringComparison.OrdinalIgnoreCase) && isOp(k + 1, "(") && isName(k + 2) && isOp(k + 3, ")"))
                { sb.Append(newAlias).Append('.').Append(Q(tk[k + 2].V)).Append(' '); k += 4; continue; }
                if (newAlias != null && isName(k) && string.Equals(x.V, "EXCLUDED", StringComparison.OrdinalIgnoreCase) && isOp(k + 1, ".") && isName(k + 2))
                { sb.Append(newAlias).Append('.').Append(Q(tk[k + 2].V)).Append(' '); k += 3; continue; }
                if (isName(k) && own.Contains(x.V) && isOp(k + 1, ".") && isName(k + 2))
                { sb.Append(oldAlias).Append('.').Append(Q(tk[k + 2].V)).Append(' '); k += 3; continue; }
                bool prevDot = k > 0 && isOp(k - 1, ".");
                if (isName(k) && !prevDot && !isOp(k + 1, "(") && !isOp(k + 1, ".") && t.Has(x.V))
                { sb.Append(oldAlias).Append('.').Append(Q(x.V)).Append(' '); k++; continue; }
                int end = tk[k + 1].Pos;
                sb.Append(text.Substring(x.Pos, end - x.Pos));
                k++;
            }
            return sb.ToString().Trim();
        }

        // ---------- statements ----------
        void CreateTable(ScriptSession s, CreateTableS c, CancellationToken ct)
        {
            // A table named like a dataset shadows it for the rest of the script (its AS query still reads the dataset):
            // Transform writes CREATE TABLE CUSTOMERS AS SELECT ... FROM CUSTOMERS and saves CLEAN_CUSTOMERS.
            // A table defined by columns still may not take a dataset's name.
            if (s.Tables.ContainsKey(c.Name) || s.Views.ContainsKey(c.Name) || (c.AsQuery == null && Exists(s, c.Name)))
            {
                if (c.IfNotExists) return;
                if (!c.OrReplace) throw new EngineException("TABLE_EXISTS", "Table \"" + c.Name + "\" already exists.");
                if (s.Views.ContainsKey(c.Name)) throw new EngineException("TABLE_EXISTS", "\"" + c.Name + "\" is a view.");
            }
            SessTable t;
            if (c.AsQuery != null)
            {
                t = NewTableQ(s, c.Name, Parser.ParseQuery(c.AsQuery), ct);
            }
            else
            {
                if (c.Cols.Count == 0) throw new EngineException("SQL_SYNTAX", "CREATE TABLE needs at least one column.");
                List<Field> fs = new List<Field>();
                foreach (ColDef d in c.Cols) fs.Add(new Field(d.Name, d.Type));
                t = NewTable(s, c.Name, Fix(new Schema(fs)), new List<Batch>(), null);
                foreach (ColDef d in c.Cols)
                {
                    if (d.NotNull) t.NotNull.Add(d.Name);
                    if (d.Default != null) t.Defaults[d.Name] = d.Default;
                    if (d.Auto) { if (t.AutoCol != null) throw new EngineException("SQL_SYNTAX", "Only one auto-increment column is allowed."); t.AutoCol = d.Name; }
                }
                foreach (string k in c.Pk) t.Col(k);
                foreach (List<string> u in c.Uniques) foreach (string k in u) t.Col(k);
                t.Pk = c.Pk.Select(t.Col).ToList(); t.Uniques = c.Uniques.Select(u => u.Select(t.Col).ToList()).ToList(); t.Checks = new List<string>(c.Checks);
                if (t.AutoCol != null && t.Pk.Count == 0) t.Pk = new List<string> { t.AutoCol };
            }
            s.Tables[c.Name] = t; s.Dropped.Remove(c.Name); s.LastTable = c.Name;
            s.Outputs.RemoveAll(n => string.Equals(n, c.Name, StringComparison.OrdinalIgnoreCase));
            if (!c.Temp) s.Outputs.Add(c.Name);
        }
        void CreateView(ScriptSession s, CreateViewS v)
        {
            bool isView = s.Views.ContainsKey(v.Name);
            if (Exists(s, v.Name))
            {
                if (v.IfNotExists) return;
                if (!isView || !v.OrReplace) throw new EngineException("TABLE_EXISTS", (isView ? "View" : "Table") + " \"" + v.Name + "\" already exists" + (isView ? " (use CREATE OR REPLACE VIEW)." : "."));
            }
            string text = v.QueryText;
            if (v.Cols != null) text = "SELECT * FROM (" + text + ") AS __v(" + string.Join(", ", v.Cols.Select(Q)) + ")";
            string old; s.Views.TryGetValue(v.Name, out old);
            s.Views[v.Name] = text; s.Dropped.Remove(v.Name);
            try { PlanQ(Parser.ParseQuery("SELECT * FROM " + Q(v.Name)), s.Cat); }
            catch { if (old != null) s.Views[v.Name] = old; else s.Views.Remove(v.Name); throw; }
            s.LastTable = v.Name;
        }
        void Drop(ScriptSession s, DropS d)
        {
            foreach (string n in d.Names)
            {
                if (d.What == "INDEX")
                {
                    IndexDef ix;
                    if (s.Indexes.TryGetValue(n, out ix) && (d.OnTable == null || string.Equals(ix.Table, d.OnTable, StringComparison.OrdinalIgnoreCase)))
                    {
                        s.Indexes.Remove(n);
                        SessTable t;
                        if (ix.Unique && s.Tables.TryGetValue(ix.Table, out t)) { SessTable c = t.CopyMeta(); c.ShareRows(t); c.Uniques.RemoveAll(u => u.SequenceEqual(ix.Cols, StringComparer.OrdinalIgnoreCase)); s.Tables[ix.Table] = c; }
                    }
                    else if (!d.IfExists) throw new EngineException("INDEX_NOT_FOUND", "Index \"" + n + "\" not found.");
                    continue;
                }
                if (d.What == "VIEW")
                {
                    if (s.Views.Remove(n)) { if (string.Equals(s.LastTable, n, StringComparison.OrdinalIgnoreCase)) s.LastTable = null; continue; }
                    if (s.Tables.ContainsKey(n) || Exists(s, n)) throw new EngineException("SQL_DROP", "\"" + n + "\" is a table, not a view.");
                    if (!d.IfExists) throw new EngineException("VIEW_NOT_FOUND", "View \"" + n + "\" not found.");
                    continue;
                }
                if (s.Views.ContainsKey(n)) throw new EngineException("SQL_DROP", "\"" + n + "\" is a view; use DROP VIEW.");
                if (s.Tables.Remove(n))
                {
                    foreach (string k in s.Indexes.Where(kv => string.Equals(kv.Value.Table, n, StringComparison.OrdinalIgnoreCase)).Select(kv => kv.Key).ToList()) s.Indexes.Remove(k);
                    if (string.Equals(s.LastTable, n, StringComparison.OrdinalIgnoreCase)) s.LastTable = null;
                    if (s.Cat.BaseViewSql(n) != null || tables.ContainsKey(n)) s.Dropped.Add(n);   // a dataset stays hidden for the rest of the script
                    continue;
                }
                if (Exists(s, n)) { s.Dropped.Add(n); continue; }
                if (!d.IfExists) throw new EngineException("TABLE_NOT_FOUND", "Table \"" + n + "\" not found.");
            }
        }

        // Rows for INSERT: a query with one output column per table column (cast to its type).
        string InsertRows(ScriptSession s, SessTable t, List<string> cols, List<List<string>> rows, string queryText, bool defaultValues)
        {
            int n = cols.Count;
            string src;
            if (defaultValues) src = "SELECT 1 AS __d";
            else if (rows != null)
            {
                StringBuilder sb = new StringBuilder("SELECT * FROM (VALUES ");
                for (int r = 0; r < rows.Count; r++)
                {
                    if (rows[r].Count != n) throw new EngineException("SQL_COLUMNS", "INSERT names " + n + " column(s) but row " + (r + 1) + " has " + rows[r].Count + " value(s).");
                    if (r > 0) sb.Append(", ");
                    sb.Append('(');
                    for (int j = 0; j < n; j++) { if (j > 0) sb.Append(", "); sb.Append(rows[r][j] == null ? DefaultSql(t, cols[j]) : "(" + rows[r][j] + ")"); }
                    sb.Append(')');
                }
                src = sb.Append(") AS __s(" + string.Join(", ", Enumerable.Range(1, n).Select(j => "__c" + j)) + ")").ToString();
            }
            else
            {
                Schema qs = PlanQ(Parser.ParseQuery(queryText), s.Cat).Op.Schema;
                if (qs.Count != n) throw new EngineException("SQL_COLUMNS", "INSERT names " + n + " column(s) but the query returns " + qs.Count + ".");
                src = "SELECT * FROM (" + queryText + ") AS __s(" + string.Join(", ", Enumerable.Range(1, n).Select(j => "__c" + j)) + ")";
            }
            List<string> items = new List<string>();
            foreach (Field f in t.Schema.Fields)
            {
                int j = cols.FindIndex(c => string.Equals(c, f.Name, StringComparison.OrdinalIgnoreCase));
                string e = j >= 0 ? "__v.__c" + (j + 1) : DefaultSql(t, f.Name);
                items.Add(CastSql(e, f.Type) + " AS " + Q(f.Name));
            }
            return "SELECT " + string.Join(", ", items) + " FROM (" + src + ") AS __v";
        }
        List<string> TargetCols(SessTable t, List<string> cols)
        {
            if (cols == null) return t.Schema.Fields.Select(f => f.Name).ToList();
            List<string> r = cols.Select(t.Col).ToList();
            string dup = r.GroupBy(x => x, StringComparer.OrdinalIgnoreCase).Where(g => g.Count() > 1).Select(g => g.Key).FirstOrDefault();
            if (dup != null) throw new EngineException("SQL_COLUMNS", "Column \"" + dup + "\" is listed twice.");
            return r;
        }

        void Insert(ScriptSession s, InsertS st, CancellationToken ct)
        {
            SessTable t = Get(s, st.Table, ct);
            List<string> cols = st.DefaultValues ? new List<string>() : TargetCols(t, st.Cols);
            Result nr = Run(s, InsertRows(s, t, cols, st.Rows, st.QueryText, st.DefaultValues), ct);
            List<Batch> rows = nr.Batches.Select(b => Conform(b, t.Schema)).ToList();
            FillAuto(t, t.Batches, rows);
            bool upsert = st.OnDup != null || st.OnConflict || st.OrReplace || st.OrIgnore;
            List<string> key = st.ConflictCols != null ? st.ConflictCols.Select(t.Col).ToList() : t.Pk.Count > 0 ? t.Pk : t.Uniques.FirstOrDefault();
            if (st.ConflictCols != null && !(t.Pk.Count > 0 && t.Pk.SequenceEqual(key, StringComparer.OrdinalIgnoreCase)) && !t.Uniques.Any(u => u.SequenceEqual(key, StringComparer.OrdinalIgnoreCase)))
                throw new EngineException("SQL_CONFLICT", "ON CONFLICT (" + string.Join(", ", key) + ") needs a PRIMARY KEY or UNIQUE constraint on those columns.");
            if (!upsert || key == null || key.Count == 0) { Put(s, t, t.Schema, t.Batches.Concat(rows).ToList(), ct, false); return; }

            // Upsert: rows whose key exists update (or replace / keep) the existing row; the others are inserted.
            int[] ki = Idx(t, key);
            HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (Batch b in rows) for (int i = 0; i < b.Rows; i++) { string kv = Key(b, ki, i); if (kv != null && !seen.Add(kv)) throw new EngineException("CONSTRAINT_UNIQUE", "The inserted rows contain the same key (" + string.Join(", ", key) + ") twice."); }
            string tmp = "__new" + (++s.Seq);
            s.Tables[tmp] = NewTable(s, tmp, t.Schema, rows, null);
            try
            {
                string on = string.Join(" AND ", key.Select(k => "__t." + Q(k) + " = __n." + Q(k)));
                List<Assign> sets = st.OnDup ?? st.ConflictSets;
                Dictionary<string, string> assign = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                if (sets != null) foreach (Assign a in sets) assign[t.Col(a.Col)] = a.Expr == null ? DefaultSql(t, a.Col) : RewriteRefs(a.Expr, t, new[] { t.Name }, "__t", "__n");
                string when = "__n.__m" + (st.ConflictWhere != null ? " AND (" + RewriteRefs(st.ConflictWhere, t, new[] { t.Name }, "__t", "__n") + ")" : "");
                List<string> items = new List<string>();
                foreach (Field f in t.Schema.Fields)
                {
                    string old = "__t." + Q(f.Name), e;
                    if (st.OrReplace) e = "CASE WHEN __n.__m THEN __n." + Q(f.Name) + " ELSE " + old + " END";
                    else if (assign.ContainsKey(f.Name)) e = "CASE WHEN " + when + " THEN " + CastSql(assign[f.Name], f.Type) + " ELSE " + old + " END";
                    else e = old;
                    items.Add(e + " AS " + Q(f.Name));
                }
                string upd = "SELECT " + string.Join(", ", items) + " FROM " + Q(t.Name) + " AS __t LEFT JOIN (SELECT *, TRUE AS __m FROM " + Q(tmp) + ") AS __n ON " + on;
                string ins = "SELECT __n.* FROM " + Q(tmp) + " AS __n LEFT JOIN (SELECT " + string.Join(", ", key.Select(Q)) + ", TRUE AS __e FROM " + Q(t.Name) + ") AS __t ON " + on + " WHERE __t.__e IS NULL";
                List<Batch> all = Run(s, upd, ct).Batches;
                all.AddRange(Run(s, ins, ct).Batches);
                s.Tables.Remove(tmp);
                Put(s, t, t.Schema, all, ct, false);
            }
            finally { s.Tables.Remove(tmp); }
        }

        void Update(ScriptSession s, UpdateS u, CancellationToken ct)
        {
            if (u.From != null) throw new EngineException("SQL_UNSUPPORTED", "UPDATE ... FROM is not supported; use a subquery in SET (SET c = (SELECT ... WHERE ...)) or MERGE.");
            SessTable t = Get(s, u.Table, ct);
            string a = u.Alias ?? t.Name;
            Dictionary<string, string> assign = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (Assign x in u.Sets)
            {
                string c = t.Col(x.Col);
                if (assign.ContainsKey(c)) throw new EngineException("SQL_COLUMNS", "Column \"" + c + "\" is set twice.");
                assign[c] = x.Expr ?? DefaultSql(t, c);
            }
            string cond = u.Where != null ? "(" + u.Where + ")" : "TRUE";
            List<string> items = new List<string>();
            foreach (Field f in t.Schema.Fields)
            {
                string old = Q(a) + "." + Q(f.Name);
                items.Add((assign.ContainsKey(f.Name) ? "CASE WHEN " + cond + " THEN " + CastSql(assign[f.Name], f.Type) + " ELSE " + old + " END" : old) + " AS " + Q(f.Name));
            }
            Result r = Run(s, "SELECT " + string.Join(", ", items) + " FROM " + Q(t.Name) + " AS " + Q(a), ct);
            Put(s, t, t.Schema, r.Batches, ct, false);
        }

        void Delete(ScriptSession s, DeleteS d, CancellationToken ct)
        {
            SessTable t = Get(s, d.Table, ct);
            string a = d.Alias ?? t.Name;
            List<Batch> keep = d.Where == null ? new List<Batch>()
                : Run(s, "SELECT " + string.Join(", ", t.Schema.Fields.Select(f => Q(a) + "." + Q(f.Name))) + " FROM " + Q(t.Name) + " AS " + Q(a) + " WHERE NOT coalesce((" + d.Where + "), FALSE)", ct).Batches;
            Put(s, t, t.Schema, keep, ct, false);
        }

        void Alter(ScriptSession s, AlterS a, CancellationToken ct)
        {
            foreach (AlterOp o in a.Ops)
            {
                SessTable t = Get(s, a.Table, ct);
                string tq = Q(t.Name);
                List<string> all = t.Schema.Fields.Select(f => f.Name).ToList();
                switch (o.Op)
                {
                    case "NOOP": break;
                    case "ADD COLUMN":
                        {
                            ColDef d = o.Col;
                            if (t.Has(d.Name)) { if (o.IfNotExists) break; throw new EngineException("SQL_COLUMNS", "Column \"" + d.Name + "\" already exists."); }
                            if (d.NotNull && d.Default == null && !d.Auto && t.Rows > 0) throw new EngineException("CONSTRAINT_NOT_NULL", "Column \"" + d.Name + "\" is NOT NULL but has no DEFAULT, and the table has rows.");
                            Result r = Run(s, "SELECT *, " + CastSql(d.Default ?? "NULL", d.Type) + " AS " + Q(d.Name) + " FROM " + tq, ct);
                            List<Field> fs = new List<Field>(t.Schema.Fields); fs.Add(new Field(d.Name, d.Type));
                            SessTable m = t.CopyMeta(); m.Schema = new Schema(fs);
                            if (d.NotNull) m.NotNull.Add(d.Name);
                            if (d.Default != null) m.Defaults[d.Name] = d.Default;
                            if (d.Pk) m.Pk = new List<string> { d.Name };
                            if (d.Unique) m.Uniques.Add(new List<string> { d.Name });
                            if (d.Check != null) m.Checks.Add(d.Check);
                            List<Batch> rows = r.Batches.Select(b => Conform(b, m.Schema)).ToList();
                            if (d.Auto) { m.AutoCol = d.Name; FillAuto(m, new List<Batch>(), rows); }
                            Put(s, m, m.Schema, rows, ct, false);
                            break;
                        }
                    case "DROP COLUMN":
                        {
                            if (!t.Has(o.Name)) { if (o.IfExists) break; t.Col(o.Name); }
                            string c = t.Col(o.Name);
                            if (all.Count == 1) throw new EngineException("SQL_COLUMNS", "Can't drop the only column of \"" + t.Name + "\".");
                            if (t.Pk.Contains(c, StringComparer.OrdinalIgnoreCase)) throw new EngineException("SQL_COLUMNS", "Column \"" + c + "\" is part of the primary key.");
                            Result r = Run(s, "SELECT " + string.Join(", ", all.Where(x => x != c).Select(Q)) + " FROM " + tq, ct);
                            SessTable m = t.CopyMeta(); m.Schema = new Schema(t.Schema.Fields.Where(f => f.Name != c).ToList());
                            m.NotNull.Remove(c); m.Defaults.Remove(c); m.Uniques.RemoveAll(u => u.Contains(c, StringComparer.OrdinalIgnoreCase)); if (string.Equals(m.AutoCol, c, StringComparison.OrdinalIgnoreCase)) m.AutoCol = null;
                            Put(s, m, m.Schema, r.Batches, ct, false);
                            break;
                        }
                    case "MODIFY COLUMN": case "CHANGE COLUMN": case "SET TYPE":
                        {
                            string c = t.Col(o.Op == "MODIFY COLUMN" ? o.Col.Name : o.Name);
                            DataType nt = o.Op == "SET TYPE" ? o.Type : o.Col.Type;
                            string nn = o.Op == "CHANGE COLUMN" ? o.Col.Name : c;
                            if (!string.Equals(nn, c, StringComparison.OrdinalIgnoreCase) && t.Has(nn)) throw new EngineException("SQL_COLUMNS", "Column \"" + nn + "\" already exists.");
                            Result r = Run(s, "SELECT " + string.Join(", ", all.Select(x => x == c ? CastSql(Q(x), nt) + " AS " + Q(nn) : Q(x))) + " FROM " + tq, ct);
                            SessTable m = t.CopyMeta(); m.Schema = new Schema(t.Schema.Fields.Select(f => f.Name == c ? new Field(nn, nt) : f).ToList());
                            Rename(m, c, nn);
                            if (o.Op != "SET TYPE")
                            {
                                // MySQL MODIFY / CHANGE redefine the column: its NOT NULL / DEFAULT come from the new definition.
                                m.NotNull.Remove(nn); m.Defaults.Remove(nn);
                                if (o.Col.NotNull) m.NotNull.Add(nn);
                                if (o.Col.Default != null) m.Defaults[nn] = o.Col.Default;
                                if (o.Col.Auto) m.AutoCol = nn;
                            }
                            Put(s, m, m.Schema, r.Batches, ct, false);
                            break;
                        }
                    case "SET DEFAULT": { SessTable m = Same(t); m.Defaults[t.Col(o.Name)] = o.Expr; s.Tables[t.Name] = m; break; }
                    case "DROP DEFAULT": { SessTable m = Same(t); m.Defaults.Remove(t.Col(o.Name)); s.Tables[t.Name] = m; break; }
                    case "SET NOT NULL": { SessTable m = t.CopyMeta(); m.NotNull.Add(t.Col(o.Name)); Put(s, m, t.Schema, t.Batches, ct, false); break; }
                    case "DROP NOT NULL": { SessTable m = Same(t); m.NotNull.Remove(t.Col(o.Name)); s.Tables[t.Name] = m; break; }
                    case "RENAME COLUMN":
                        {
                            string c = t.Col(o.Name);
                            if (t.Has(o.NewName) && !string.Equals(o.NewName, c, StringComparison.OrdinalIgnoreCase)) throw new EngineException("SQL_COLUMNS", "Column \"" + o.NewName + "\" already exists.");
                            SessTable m = Same(t); m.Schema = new Schema(t.Schema.Fields.Select(f => f.Name == c ? new Field(o.NewName, f.Type) : f).ToList());
                            m.Batches = t.Batches.Select(b => new Batch(m.Schema, b.Cols, b.Rows)).ToList();
                            Rename(m, c, o.NewName);
                            s.Tables[t.Name] = m;
                            break;
                        }
                    case "RENAME TO":
                        {
                            if (Exists(s, o.NewName)) throw new EngineException("TABLE_EXISTS", "Table \"" + o.NewName + "\" already exists.");
                            SessTable m = Same(t); m.Name = o.NewName;
                            s.Tables.Remove(t.Name); s.Tables[o.NewName] = m;
                            foreach (IndexDef ix in s.Indexes.Values) if (string.Equals(ix.Table, t.Name, StringComparison.OrdinalIgnoreCase)) ix.Table = o.NewName;
                            a.Table = o.NewName;
                            break;
                        }
                    case "ADD PRIMARY KEY":
                        {
                            if (t.Pk.Count > 0) throw new EngineException("SQL_CONSTRAINT", "Table \"" + t.Name + "\" already has a primary key.");
                            SessTable m = t.CopyMeta(); m.Pk = o.Cols.Select(t.Col).ToList(); Put(s, m, t.Schema, t.Batches, ct, false); break;
                        }
                    case "ADD UNIQUE": { SessTable m = t.CopyMeta(); m.Uniques.Add(o.Cols.Select(t.Col).ToList()); Put(s, m, t.Schema, t.Batches, ct, false); break; }
                    case "ADD CHECK": { SessTable m = t.CopyMeta(); m.Checks.Add(o.Expr); Put(s, m, t.Schema, t.Batches, ct, false); break; }
                    case "DROP PRIMARY KEY": { SessTable m = Same(t); m.Pk.Clear(); s.Tables[t.Name] = m; break; }
                    case "DROP CONSTRAINT":
                        {
                            // Constraint names are not kept: a name containing "pk"/"primary" drops the primary key, "uq"/"unique" the unique keys, "chk"/"check" the checks.
                            SessTable m = Same(t); string n = o.Name.ToLowerInvariant();
                            if (n.Contains("pk") || n.Contains("primary")) m.Pk.Clear();
                            else if (n.Contains("uq") || n.Contains("unique")) m.Uniques.Clear();
                            else if (n.Contains("chk") || n.Contains("check")) m.Checks.Clear();
                            else if (!o.IfExists) throw new EngineException("SQL_CONSTRAINT", "Constraint \"" + o.Name + "\" not found.");
                            s.Tables[t.Name] = m;
                            break;
                        }
                    default: throw new EngineException("SQL_UNSUPPORTED", "ALTER TABLE " + o.Op + " is not supported.");
                }
                s.LastTable = a.Table;
            }
        }
        // Same rows, copied metadata (for changes that don't touch data).
        static SessTable Same(SessTable t) { SessTable m = t.CopyMeta(); m.ShareRows(t); return m; }
        static void Rename(SessTable m, string from, string to)
        {
            if (string.Equals(from, to, StringComparison.Ordinal)) return;
            Func<string, string> f = x => string.Equals(x, from, StringComparison.OrdinalIgnoreCase) ? to : x;
            m.Pk = m.Pk.Select(f).ToList(); m.Uniques = m.Uniques.Select(u => u.Select(f).ToList()).ToList();
            m.NotNull = new HashSet<string>(m.NotNull.Select(f), StringComparer.OrdinalIgnoreCase);
            string d; if (m.Defaults.TryGetValue(from, out d)) { m.Defaults.Remove(from); m.Defaults[to] = d; }
            if (m.AutoCol != null) m.AutoCol = f(m.AutoCol);
        }

        // MERGE: target rows get a row id, source rows a source id; matches are (rid, sid) pairs (a target row matched
        // by two source rows is an error). Each target row takes the first WHEN clause that applies.
        void Merge(ScriptSession s, MergeS m, CancellationToken ct)
        {
            SessTable t = Get(s, m.Target, ct);
            string ta = m.TAlias ?? t.Name, sa = m.SAlias;
            int id = ++s.Seq;
            string tgt = "__mt" + id, srcT = "__ms" + id, pairs = "__mp" + id;
            try
            {
                Result tr = Run(s, "SELECT *, row_number() OVER () AS __rid FROM " + Q(t.Name), ct);
                s.Tables[tgt] = NewTable(s, tgt, Fix(tr.Schema), tr.Batches, null);
                Result sr = Run(s, "SELECT *, row_number() OVER () AS __sid FROM " + m.Source + " AS " + Q(sa), ct);
                s.Tables[srcT] = NewTable(s, srcT, Fix(sr.Schema), sr.Batches, null);
                Result pr = Run(s, "SELECT " + Q(ta) + ".__rid AS __mr, " + Q(sa) + ".__sid AS __mq FROM " + Q(tgt) + " AS " + Q(ta) + " JOIN " + Q(srcT) + " AS " + Q(sa) + " ON " + m.On, ct);
                s.Tables[pairs] = NewTable(s, pairs, Fix(pr.Schema), pr.Batches, null);
                if (Scalar(s, "SELECT count(*) FROM (SELECT __mr FROM " + Q(pairs) + " GROUP BY __mr HAVING count(*) > 1) AS __d", ct) > 0)
                    throw new EngineException("MERGE_DUPLICATE", "MERGE matched a target row with more than one source row; the ON condition must match at most one source row per target row.");

                // Target rows: action code per row (0 = unchanged, -1 = deleted, k = the k-th WHEN clause).
                StringBuilder act = new StringBuilder("CASE");
                List<int> deletes = new List<int>();
                for (int k = 0; k < m.Whens.Count; k++)
                {
                    MergeWhen w = m.Whens[k];
                    if (w.Match == "NOT MATCHED") continue;
                    string has = w.Match == "MATCHED" ? "__p.__mr IS NOT NULL" : "__p.__mr IS NULL";
                    act.Append(" WHEN ").Append(has).Append(w.Cond != null ? " AND coalesce((" + w.Cond + "), FALSE)" : "").Append(" THEN ").Append(k + 1);
                    if (w.Action == "DELETE") deletes.Add(k + 1);
                }
                act.Append(" ELSE 0 END");
                List<string> items = new List<string> { act + " AS __act" };
                foreach (Field f in t.Schema.Fields)
                {
                    StringBuilder e = new StringBuilder("CASE");
                    bool any = false;
                    for (int k = 0; k < m.Whens.Count; k++)
                    {
                        MergeWhen w = m.Whens[k];
                        if (w.Action != "UPDATE") continue;
                        Assign a = w.Sets.FirstOrDefault(x => string.Equals(t.Col(x.Col), f.Name, StringComparison.OrdinalIgnoreCase));
                        if (a == null) continue;
                        e.Append(" WHEN __act = ").Append(k + 1).Append(" THEN ").Append(CastSql(a.Expr ?? DefaultSql(t, f.Name), f.Type));
                        any = true;
                    }
                    string old = Q(ta) + "." + Q(f.Name);
                    items.Add((any ? e + " ELSE " + old + " END" : old) + " AS " + Q(f.Name));
                }
                foreach (MergeWhen w in m.Whens) if (w.Action == "UPDATE") foreach (Assign a in w.Sets) t.Col(a.Col);
                string body = "SELECT " + string.Join(", ", items) + " FROM " + Q(tgt) + " AS " + Q(ta) +
                    " LEFT JOIN " + Q(pairs) + " AS __p ON " + Q(ta) + ".__rid = __p.__mr LEFT JOIN " + Q(srcT) + " AS " + Q(sa) + " ON " + Q(sa) + ".__sid = __p.__mq";
                string kept = "SELECT " + string.Join(", ", t.Schema.Fields.Select(f => Q(f.Name))) + " FROM (" + body + ") AS __x" +
                    (deletes.Count > 0 ? " WHERE __act NOT IN (" + string.Join(", ", deletes) + ")" : "");
                List<Batch> rows = Run(s, kept, ct).Batches;

                // Source rows with no match: the first NOT MATCHED clause that applies inserts them.
                string prev = null;
                foreach (MergeWhen w in m.Whens)
                {
                    if (w.Match != "NOT MATCHED") continue;
                    string cond = "__u.__mq IS NULL" + (prev != null ? " AND NOT (" + prev + ")" : "") + (w.Cond != null ? " AND coalesce((" + w.Cond + "), FALSE)" : "");
                    prev = prev == null ? (w.Cond != null ? "coalesce((" + w.Cond + "), FALSE)" : "TRUE") : prev + " OR " + (w.Cond != null ? "coalesce((" + w.Cond + "), FALSE)" : "TRUE");
                    if (w.Action != "INSERT") continue;
                    List<string> cols = w.InsCols == null ? (w.InsVals.Count == 0 ? new List<string>() : t.Schema.Fields.Select(f => f.Name).ToList()) : TargetCols(t, w.InsCols);
                    if (w.InsVals.Count != cols.Count) throw new EngineException("SQL_COLUMNS", "MERGE INSERT names " + cols.Count + " column(s) but has " + w.InsVals.Count + " value(s).");
                    List<string> vals = new List<string>();
                    foreach (Field f in t.Schema.Fields)
                    {
                        int j = cols.FindIndex(c => string.Equals(c, f.Name, StringComparison.OrdinalIgnoreCase));
                        vals.Add(CastSql(j >= 0 && w.InsVals[j] != null ? w.InsVals[j] : DefaultSql(t, f.Name), f.Type) + " AS " + Q(f.Name));
                    }
                    List<Batch> ins = Run(s, "SELECT " + string.Join(", ", vals) + " FROM " + Q(srcT) + " AS " + Q(sa) +
                        " LEFT JOIN (SELECT DISTINCT __mq FROM " + Q(pairs) + ") AS __u ON " + Q(sa) + ".__sid = __u.__mq WHERE " + cond, ct).Batches;
                    List<Batch> conf = ins.Select(b => Conform(b, t.Schema)).ToList();
                    FillAuto(t, rows, conf);
                    rows.AddRange(conf);
                }
                s.Tables.Remove(tgt); s.Tables.Remove(srcT); s.Tables.Remove(pairs);
                Put(s, t, t.Schema, rows, ct, false);
            }
            finally { s.Tables.Remove(tgt); s.Tables.Remove(srcT); s.Tables.Remove(pairs); }
        }

        void CreateIndex(ScriptSession s, IndexS x, CancellationToken ct)
        {
            if (s.Indexes.ContainsKey(x.Name)) { if (x.IfNotExists) return; throw new EngineException("INDEX_EXISTS", "Index \"" + x.Name + "\" already exists."); }
            if (!Exists(s, x.Table)) throw new EngineException("TABLE_NOT_FOUND", "Table \"" + x.Table + "\" not found.");
            Schema sch = PlanQ(Parser.ParseQuery("SELECT * FROM " + Q(x.Table)), s.Cat).Op.Schema;
            List<string> cols = new List<string>();
            foreach (string c in x.Cols) { int i = sch.IndexOf(c); if (i < 0) throw new EngineException("COLUMN_NOT_FOUND", "Table \"" + x.Table + "\" has no column \"" + c + "\"."); cols.Add(sch[i].Name); }
            if (x.Clustered && s.Indexes.Values.Any(i => i.Clustered && string.Equals(i.Table, x.Table, StringComparison.OrdinalIgnoreCase)))
                throw new EngineException("INDEX_EXISTS", "Table \"" + x.Table + "\" already has a clustered index.");
            if (x.Unique)
            {
                string g = string.Join(", ", cols.Select(Q));
                if (Scalar(s, "SELECT count(*) FROM (SELECT " + g + " FROM " + Q(x.Table) + " WHERE " + string.Join(" AND ", cols.Select(c => Q(c) + " IS NOT NULL")) + " GROUP BY " + g + " HAVING count(*) > 1) AS __d", ct) > 0)
                    throw new EngineException("CONSTRAINT_UNIQUE", "Can't create unique index \"" + x.Name + "\": table \"" + x.Table + "\" has duplicate (" + string.Join(", ", cols) + ") values.");
            }
            if (x.Clustered || x.Unique)
            {
                // A clustered index stores the table in key order; a unique index is enforced from now on.
                SessTable t = Get(s, x.Table, ct);
                SessTable m = t.CopyMeta();
                if (x.Unique) m.Uniques.Add(cols);
                List<Batch> rows = x.Clustered ? Run(s, "SELECT * FROM " + Q(t.Name) + " ORDER BY " + string.Join(", ", cols.Select(Q)), ct).Batches : t.Batches;
                Put(s, m, t.Schema, rows, ct, false);
            }
            IndexDef d = new IndexDef(); d.Name = x.Name; d.Table = x.Table; d.Cols = cols; d.Unique = x.Unique; d.Clustered = x.Clustered;
            s.Indexes[x.Name] = d;
        }
    }
}
