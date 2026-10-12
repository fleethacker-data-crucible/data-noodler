using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace NativeDataEngine
{
    // Errors shown to the user: a stable code + a plain message. Details go to the log.
    public sealed class EngineException : Exception
    {
        public readonly string Code;
        public readonly int Status;
        public EngineException(string code, string message) : this(code, message, 400) { }
        public EngineException(string code, string message, int status) : base(message) { Code = code; Status = status; }
    }

    public sealed class EngineError
    {
        public string Code;
        public string Message;
        public string Component;
        public string Detail;

        public static EngineError From(Exception e)
        {
            while (e is AggregateException && e.InnerException != null) e = e.InnerException;
            while (e is System.Reflection.TargetInvocationException && e.InnerException != null) e = e.InnerException;
            EngineError r = new EngineError();
            EngineException ee = e as EngineException;
            if (ee != null) { r.Code = ee.Code; r.Message = ee.Message; }
            else if (e is OperationCanceledException) { r.Code = "CANCELLED"; r.Message = "Cancelled."; }
            else if (e is OutOfMemoryException) { r.Code = "QUERY_OUT_OF_MEMORY"; r.Message = "Out of memory. Filter or aggregate the data first, or raise the engine memory limit."; }
            else if (e is System.IO.FileNotFoundException || e is System.IO.DirectoryNotFoundException) { r.Code = "FILE_NOT_FOUND"; r.Message = e.Message; }
            else if (e is UnauthorizedAccessException) { r.Code = "ACCESS_DENIED"; r.Message = e.Message; }
            else if (e is System.IO.IOException) { r.Code = "IO_ERROR"; r.Message = e.Message; }
            else { r.Code = "ENGINE_ERROR"; r.Message = e.Message; }
            r.Component = e.TargetSite != null && e.TargetSite.DeclaringType != null ? e.TargetSite.DeclaringType.Name : null;
            r.Detail = e.ToString();
            return r;
        }
        public Dictionary<string, object> ToJson()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["code"] = Code; d["message"] = Message;
            return d;
        }
    }

    public static class Json
    {
        public static JavaScriptSerializer New()
        {
            JavaScriptSerializer s = new JavaScriptSerializer();
            s.MaxJsonLength = int.MaxValue;
            s.RecursionLimit = 256;
            return s;
        }
        public static Dictionary<string, object> Parse(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return new Dictionary<string, object>();
            object o = New().DeserializeObject(text);
            Dictionary<string, object> d = o as Dictionary<string, object>;
            if (d == null) throw new EngineException("JSON_INVALID", "Expected a JSON object.");
            return d;
        }
        public static string Write(object o) { return New().Serialize(o); }

        // Typed getters for parsed JSON (Dictionary<string, object>, object[], string, int, decimal, bool).
        public static string Str(Dictionary<string, object> d, string k)
        {
            object v; if (d == null || !d.TryGetValue(k, out v) || v == null) return null;
            return Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture);
        }
        public static long Long(Dictionary<string, object> d, string k, long def)
        {
            object v; if (d == null || !d.TryGetValue(k, out v) || v == null) return def;
            try { return Convert.ToInt64(v, System.Globalization.CultureInfo.InvariantCulture); } catch { return def; }
        }
        public static bool Bool(Dictionary<string, object> d, string k, bool def)
        {
            object v; if (d == null || !d.TryGetValue(k, out v) || v == null) return def;
            if (v is bool) return (bool)v;
            string s = Convert.ToString(v); return s == "1" || string.Equals(s, "true", StringComparison.OrdinalIgnoreCase);
        }
        public static Dictionary<string, object> Obj(Dictionary<string, object> d, string k)
        {
            object v; if (d == null || !d.TryGetValue(k, out v)) return null;
            return v as Dictionary<string, object>;
        }
        public static object[] Arr(Dictionary<string, object> d, string k)
        {
            object v; if (d == null || !d.TryGetValue(k, out v) || v == null) return null;
            object[] a = v as object[];
            if (a != null) return a;
            System.Collections.ArrayList l = v as System.Collections.ArrayList;
            return l != null ? l.ToArray() : null;
        }
        public static List<string> Strs(Dictionary<string, object> d, string k)
        {
            List<string> r = new List<string>();
            object[] a = Arr(d, k);
            if (a != null) foreach (object o in a) if (o != null) r.Add(Convert.ToString(o, System.Globalization.CultureInfo.InvariantCulture));
            return r;
        }
    }
}
