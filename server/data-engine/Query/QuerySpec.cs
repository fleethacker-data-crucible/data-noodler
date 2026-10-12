// Declarative query (dashboard widgets, plan 02 section 11) -> SQL:
//   { dataset, select: [cols], groupBy: [cols], aggregate: [{ function, column, as, distinct }],
//     where: "expr", sort: [{ column, direction } | { expr }], limit }
// function: count | count_distinct | sum | avg | min | max (count with no column = count(*)).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace NativeDataEngine
{
    public static class QuerySpec
    {
        static string Q(string n) { return "\"" + n.Replace("\"", "\"\"") + "\""; }

        public static string ToSql(Dictionary<string, object> s)
        {
            string ds = Json.Str(s, "dataset");
            if (string.IsNullOrEmpty(ds)) throw new EngineException("QUERY_INVALID", "The query needs a dataset.");
            List<string> items = new List<string>();
            List<string> groups = Json.Strs(s, "groupBy");
            foreach (string g in groups) items.Add(Q(g));
            foreach (string c in Json.Strs(s, "select")) { if (c == "*") items.Add("*"); else if (!groups.Contains(c)) items.Add(Q(c)); }
            object[] aggs = Json.Arr(s, "aggregate") ?? new object[0];
            foreach (object o in aggs)
            {
                Dictionary<string, object> a = o as Dictionary<string, object>;
                if (a == null) continue;
                string fn = (Json.Str(a, "function") ?? "count").ToLowerInvariant(), col = Json.Str(a, "column"), alias = Json.Str(a, "as") ?? fn;
                bool distinct = Json.Bool(a, "distinct", false) || fn == "count_distinct";
                if (fn == "count_distinct") fn = "count";
                switch (fn) { case "count": case "sum": case "avg": case "min": case "max": case "median": case "stddev": break; default: throw new EngineException("QUERY_INVALID", "Unknown aggregate " + fn + "."); }
                string arg = string.IsNullOrEmpty(col) ? (fn == "count" ? "*" : null) : Q(col);
                if (arg == null) throw new EngineException("QUERY_INVALID", fn + " needs a column.");
                items.Add(fn + "(" + (distinct && arg != "*" ? "DISTINCT " : "") + arg + ") AS " + Q(alias));
            }
            if (items.Count == 0) items.Add("*");
            StringBuilder sb = new StringBuilder("SELECT ");
            sb.Append(string.Join(", ", items)).Append(" FROM ").Append(Q(ds));
            string where = Json.Str(s, "where");
            if (!string.IsNullOrWhiteSpace(where)) sb.Append(" WHERE ").Append(where);
            if (groups.Count > 0) { sb.Append(" GROUP BY "); for (int i = 0; i < groups.Count; i++) sb.Append(i > 0 ? ", " : "").Append(i + 1); }
            object[] sort = Json.Arr(s, "sort");
            if (sort != null && sort.Length > 0)
            {
                List<string> ob = new List<string>();
                foreach (object o in sort)
                {
                    Dictionary<string, object> x = o as Dictionary<string, object>;
                    if (x == null) continue;
                    string expr = Json.Str(x, "expr");
                    if (!string.IsNullOrWhiteSpace(expr)) { ob.Add(expr); continue; }
                    bool desc = string.Equals(Json.Str(x, "direction"), "desc", StringComparison.OrdinalIgnoreCase);
                    ob.Add(Q(Json.Str(x, "column")) + (desc ? " DESC NULLS LAST" : ""));
                }
                if (ob.Count > 0) sb.Append(" ORDER BY ").Append(string.Join(", ", ob));
            }
            long limit = Json.Long(s, "limit", -1);
            if (limit > 0) sb.Append(" LIMIT ").Append(limit.ToString(CultureInfo.InvariantCulture));
            return sb.ToString();
        }
    }
}
