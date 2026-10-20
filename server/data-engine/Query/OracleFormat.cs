// Oracle format models: TO_CHAR(date | number, fmt), TO_DATE / TO_TIMESTAMP(text, fmt), TO_NUMBER(text, fmt), and the
// Oracle regular-expression helpers (POSIX classes, match flags). C# 5 only (compiled by PowerShell 5.1 Add-Type).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace NativeDataEngine
{
    public static class OraFormat
    {
        // ---------- date format models ----------
        sealed class Tok { public string E; public string Raw; public bool Lit; }   // E: element (upper case), Raw: as written
        static readonly string[] Elements = {
            "SYYYY", "YYYY", "RRRR", "MONTH", "HH24", "HH12", "A.M.", "P.M.", "YYY", "MON", "DDD", "DAY",
            "FF1", "FF2", "FF3", "FF4", "FF5", "FF6", "FF7", "FF8", "FF9", "YY", "RR", "MM", "DD", "DY", "HH", "MI", "SS", "FF",
            "AM", "PM", "IW", "WW", "FM", "FX", "Y", "D", "Q", "W", "J" };
        static readonly Dictionary<string, List<Tok>> cache = new Dictionary<string, List<Tok>>();

        static List<Tok> Parse(string fmt)
        {
            List<Tok> r;
            lock (cache) if (cache.TryGetValue(fmt, out r)) return r;
            r = new List<Tok>();
            int i = 0;
            while (i < fmt.Length)
            {
                char c = fmt[i];
                if (c == '"')
                {
                    int e = fmt.IndexOf('"', i + 1); if (e < 0) e = fmt.Length;
                    Tok t = new Tok(); t.Lit = true; t.Raw = fmt.Substring(i + 1, e - i - 1); r.Add(t); i = e + 1; continue;
                }
                string hit = null;
                foreach (string el in Elements)
                    if (i + el.Length <= fmt.Length && string.Compare(fmt, i, el, 0, el.Length, StringComparison.OrdinalIgnoreCase) == 0) { hit = el; break; }
                if (hit != null) { Tok t = new Tok(); t.E = hit; t.Raw = fmt.Substring(i, hit.Length); r.Add(t); i += hit.Length; continue; }
                if (char.IsLetterOrDigit(c)) throw new EngineException("FORMAT_INVALID", "Unknown date format element at '" + fmt.Substring(i) + "' in '" + fmt + "'.");
                Tok p = new Tok(); p.Lit = true; p.Raw = c.ToString(); r.Add(p); i++;
            }
            lock (cache) cache[fmt] = r;
            return r;
        }
        // True when the format has a time of day (TO_DATE then returns a date-time).
        public static bool HasTime(string fmt)
        {
            foreach (Tok t in Parse(fmt))
                if (!t.Lit && (t.E.StartsWith("HH") || t.E == "MI" || t.E == "SS" || t.E.StartsWith("FF") || t.E == "AM" || t.E == "PM" || t.E == "A.M." || t.E == "P.M.")) return true;
            return false;
        }
        // MON / Mon / mon: upper, capitalised or lower like the element as written.
        static string CaseLike(string raw, string word)
        {
            if (raw.Length > 1 && char.IsUpper(raw[0]) && char.IsLower(raw[1])) return word.Substring(0, 1).ToUpperInvariant() + word.Substring(1).ToLowerInvariant();
            if (char.IsLower(raw[0])) return word.ToLowerInvariant();
            return word.ToUpperInvariant();
        }
        static readonly string[] MonthNames = CultureInfo.InvariantCulture.DateTimeFormat.MonthNames;
        static readonly string[] DayNames = CultureInfo.InvariantCulture.DateTimeFormat.DayNames;

        public static string FormatDate(DateTime d, string fmt, long micros)
        {
            StringBuilder sb = new StringBuilder(); bool fm = false;
            foreach (Tok t in Parse(fmt))
            {
                if (t.Lit) { sb.Append(t.Raw); continue; }
                switch (t.E)
                {
                    case "FM": fm = !fm; break;
                    case "FX": break;
                    case "SYYYY": case "YYYY": case "RRRR": sb.Append(fm ? d.Year.ToString(CultureInfo.InvariantCulture) : d.Year.ToString("0000", CultureInfo.InvariantCulture)); break;
                    case "YYY": sb.Append((d.Year % 1000).ToString("000", CultureInfo.InvariantCulture)); break;
                    case "YY": case "RR": sb.Append((d.Year % 100).ToString("00", CultureInfo.InvariantCulture)); break;
                    case "Y": sb.Append((d.Year % 10).ToString(CultureInfo.InvariantCulture)); break;
                    case "MM": sb.Append(Num(d.Month, 2, fm)); break;
                    case "MON": sb.Append(CaseLike(t.Raw, MonthNames[d.Month - 1].Substring(0, 3))); break;
                    case "MONTH": { string m = CaseLike(t.Raw, MonthNames[d.Month - 1]); sb.Append(fm ? m : m.PadRight(9)); break; }
                    case "DD": sb.Append(Num(d.Day, 2, fm)); break;
                    case "DDD": sb.Append(Num(d.DayOfYear, 3, fm)); break;
                    case "D": sb.Append((int)d.DayOfWeek + 1); break;
                    case "DY": sb.Append(CaseLike(t.Raw, DayNames[(int)d.DayOfWeek].Substring(0, 3))); break;
                    case "DAY": { string w = CaseLike(t.Raw, DayNames[(int)d.DayOfWeek]); sb.Append(fm ? w : w.PadRight(9)); break; }
                    case "HH": case "HH12": { int h = d.Hour % 12; if (h == 0) h = 12; sb.Append(Num(h, 2, fm)); break; }
                    case "HH24": sb.Append(Num(d.Hour, 2, fm)); break;
                    case "MI": sb.Append(Num(d.Minute, 2, fm)); break;
                    case "SS": sb.Append(Num(d.Second, 2, fm)); break;
                    case "AM": case "PM": sb.Append(CaseLike(t.Raw, d.Hour < 12 ? "AM" : "PM")); break;
                    case "A.M.": case "P.M.": sb.Append(CaseLike(t.Raw, d.Hour < 12 ? "A.M." : "P.M.")); break;
                    case "Q": sb.Append((d.Month - 1) / 3 + 1); break;
                    case "WW": sb.Append(Num((d.DayOfYear - 1) / 7 + 1, 2, fm)); break;
                    case "IW": sb.Append(Num(CultureInfo.InvariantCulture.Calendar.GetWeekOfYear(d.AddDays(3 - ((int)d.DayOfWeek + 6) % 7), CalendarWeekRule.FirstFourDayWeek, DayOfWeek.Monday), 2, fm)); break;
                    case "W": sb.Append((d.Day - 1) / 7 + 1); break;
                    case "J": sb.Append((long)(d.Date - new DateTime(1, 1, 1)).TotalDays + 1721426); break;
                    default:
                        if (t.E.StartsWith("FF"))
                        {
                            int digits = t.E.Length > 2 ? t.E[2] - '0' : 6;
                            long frac = ((micros % 1000000) + 1000000) % 1000000;   // microseconds of the second
                            string f6 = frac.ToString("000000", CultureInfo.InvariantCulture);
                            sb.Append(digits <= 6 ? f6.Substring(0, digits) : f6.PadRight(digits, '0'));
                        }
                        break;
                }
            }
            return sb.ToString();
        }
        static string Num(int v, int width, bool fm) { return fm ? v.ToString(CultureInfo.InvariantCulture) : v.ToString(new string('0', width), CultureInfo.InvariantCulture); }

        // TO_DATE / TO_TIMESTAMP: lenient like Oracle (punctuation in the format matches any punctuation or none,
        // numbers may have fewer digits, month / day names in any case). Missing parts: current year and month, day 1, 00:00:00.
        public static bool ParseDate(string s, string fmt, out long micros)
        {
            micros = 0;
            if (s == null) return false;
            DateTime now = DateTime.Now;
            int year = now.Year, month = now.Month, day = 1, hour = 0, min = 0, sec = 0, doy = -1; long frac = 0; int pm = -1; bool h12 = false;
            int i = 0, n = s.Length;
            foreach (Tok t in Parse(fmt))
            {
                if (t.Lit)
                {
                    // literal text / punctuation: skip it in the input if it is there (any punctuation matches)
                    if (t.Raw.Trim().Length == 0) { while (i < n && s[i] == ' ') i++; continue; }
                    if (t.Raw.Length == 1 && !char.IsLetterOrDigit(t.Raw[0])) { if (i < n && !char.IsLetterOrDigit(s[i])) i++; continue; }
                    if (string.Compare(s, i, t.Raw, 0, t.Raw.Length, StringComparison.OrdinalIgnoreCase) == 0) i += t.Raw.Length;
                    continue;
                }
                while (i < n && s[i] == ' ') i++;
                int v, digits;
                switch (t.E)
                {
                    case "FM": case "FX": break;
                    case "SYYYY": case "YYYY": case "RRRR": case "YYY": case "YY": case "RR": case "Y":
                        {
                            int max = t.E == "YY" || t.E == "RR" ? 4 : t.E == "Y" ? 1 : t.E == "YYY" ? 3 : 4;
                            if (!Digits(s, ref i, max, out v, out digits)) return false;
                            if (digits <= 2 && (t.E == "RR" || t.E == "RRRR" || t.E == "YYYY" || t.E == "SYYYY")) year = v < 50 ? 2000 + v : 1900 + v;
                            else if (digits <= 2 && t.E == "YY") year = now.Year / 100 * 100 + v;
                            else if (t.E == "YYY") year = now.Year / 1000 * 1000 + v;
                            else if (t.E == "Y") year = now.Year / 10 * 10 + v;
                            else year = v;
                            break;
                        }
                    case "MM": if (!Digits(s, ref i, 2, out month, out digits)) return false; break;
                    case "MON": case "MONTH":
                        {
                            int m = -1;
                            for (int k = 0; k < 12 && m < 0; k++)
                                if (string.Compare(s, i, MonthNames[k], 0, MonthNames[k].Length, StringComparison.OrdinalIgnoreCase) == 0) { m = k + 1; i += MonthNames[k].Length; }
                            for (int k = 0; k < 12 && m < 0; k++)
                                if (string.Compare(s, i, MonthNames[k], 0, 3, StringComparison.OrdinalIgnoreCase) == 0) { m = k + 1; i += 3; }
                            if (m < 0) return false;
                            month = m; break;
                        }
                    case "DD": if (!Digits(s, ref i, 2, out day, out digits)) return false; break;
                    case "DDD": if (!Digits(s, ref i, 3, out doy, out digits)) return false; break;
                    case "D": if (!Digits(s, ref i, 1, out v, out digits)) return false; break;
                    case "DY": case "DAY": while (i < n && char.IsLetter(s[i])) i++; break;
                    case "HH": case "HH12": if (!Digits(s, ref i, 2, out hour, out digits)) return false; h12 = true; break;
                    case "HH24": if (!Digits(s, ref i, 2, out hour, out digits)) return false; break;
                    case "MI": if (!Digits(s, ref i, 2, out min, out digits)) return false; break;
                    case "SS": if (!Digits(s, ref i, 2, out sec, out digits)) return false; break;
                    case "AM": case "PM": case "A.M.": case "P.M.":
                        {
                            string rest = s.Substring(i).ToUpperInvariant();
                            if (rest.StartsWith("A.M.")) { pm = 0; i += 4; } else if (rest.StartsWith("P.M.")) { pm = 1; i += 4; }
                            else if (rest.StartsWith("AM")) { pm = 0; i += 2; } else if (rest.StartsWith("PM")) { pm = 1; i += 2; }
                            else return false;
                            break;
                        }
                    default:
                        if (t.E.StartsWith("FF"))
                        {
                            int st = i; long f = 0; while (i < n && char.IsDigit(s[i]) && i - st < 9) { f = f * 10 + (s[i] - '0'); i++; }
                            int d = i - st; if (d == 0) return false;
                            while (d < 6) { f *= 10; d++; } while (d > 6) { f /= 10; d--; }
                            frac = f;
                        }
                        else return false;   // Q, W, WW, IW, J: not for input
                        break;
                }
            }
            while (i < n && char.IsWhiteSpace(s[i])) i++;
            if (i < n) return false;   // text left over
            if (pm >= 0 || h12) { if (hour < 1 || hour > 12) return false; hour = hour % 12 + (pm == 1 ? 12 : 0); }
            if (month < 1 || month > 12 || year < 1 || year > 9999 || hour > 23 || min > 59 || sec > 59) return false;
            DateTime dt;
            if (doy > 0) { if (doy > (DateTime.IsLeapYear(year) ? 366 : 365)) return false; dt = new DateTime(year, 1, 1).AddDays(doy - 1); }
            else { if (day < 1 || day > DateTime.DaysInMonth(year, month)) return false; dt = new DateTime(year, month, day); }
            dt = DateTime.SpecifyKind(dt.Add(new TimeSpan(hour, min, sec)), DateTimeKind.Utc);
            micros = Values.Micros(dt) + frac;
            return true;
        }
        static bool Digits(string s, ref int i, int max, out int v, out int count)
        {
            v = 0; count = 0;
            while (i < s.Length && count < max && char.IsDigit(s[i])) { v = v * 10 + (s[i] - '0'); i++; count++; }
            return count > 0;
        }

        // ---------- number format models ----------
        // 9 digit (blank when leading), 0 digit (zero kept), . or D decimal point, , or G group, $ / L currency,
        // FM no padding, MI trailing minus, S leading / trailing sign, PR <negative>. Too few digits: '#' * width.
        public static string FormatNumber(double v, string fmt)
        {
            string f = fmt; bool fm = false, mi = false, pr = false, dollar = false; int sLead = 0;   // sLead: 1 leading S, 2 trailing S
            if (f.StartsWith("FM", StringComparison.OrdinalIgnoreCase)) { fm = true; f = f.Substring(2); }
            if (f.EndsWith("MI", StringComparison.OrdinalIgnoreCase)) { mi = true; f = f.Substring(0, f.Length - 2); }
            if (f.EndsWith("PR", StringComparison.OrdinalIgnoreCase)) { pr = true; f = f.Substring(0, f.Length - 2); }
            if (f.StartsWith("S", StringComparison.OrdinalIgnoreCase)) { sLead = 1; f = f.Substring(1); }
            else if (f.EndsWith("S", StringComparison.OrdinalIgnoreCase)) { sLead = 2; f = f.Substring(0, f.Length - 1); }
            if (f.IndexOf('$') >= 0 || f.IndexOf('L') >= 0 || f.IndexOf('l') >= 0) { dollar = true; f = f.Replace("$", "").Replace("L", "").Replace("l", ""); }
            f = f.Replace('D', '.').Replace('d', '.').Replace('G', ',').Replace('g', ',');
            int dot = f.IndexOf('.');
            string ip = dot >= 0 ? f.Substring(0, dot) : f, dp = dot >= 0 ? f.Substring(dot + 1) : "";
            foreach (char ch in ip + dp) if (ch != '9' && ch != '0' && ch != ',') throw new EngineException("FORMAT_INVALID", "Unknown number format '" + fmt + "'.");
            int decimals = dp.Length;
            bool neg = v < 0; double a = Math.Round(Math.Abs(v), decimals, MidpointRounding.AwayFromZero);
            string digits = a.ToString("F" + decimals, CultureInfo.InvariantCulture);
            string intDigits = digits.Split('.')[0], fracDigits = decimals > 0 ? digits.Split('.')[1] : "";
            int slots = 0; foreach (char ch in ip) if (ch != ',') slots++;
            int firstZero = ip.IndexOf('0');
            if (intDigits == "0" && (firstZero < 0 || ip.Length - firstZero == 0)) intDigits = "";   // .5 for 9.99 (Oracle) unless a 0 asks for it
            if (intDigits.Length > slots)
            {
                int w = ip.Length + (decimals > 0 ? decimals + 1 : 0) + 1 + (dollar ? 1 : 0);
                return new string('#', w);
            }
            // fill the integer slots right to left
            StringBuilder ib = new StringBuilder(); int di = intDigits.Length - 1; bool started = true;
            int zeroFrom = firstZero < 0 ? int.MaxValue : firstZero;
            for (int k = ip.Length - 1; k >= 0; k--)
            {
                char ch = ip[k];
                if (ch == ',')
                {
                    bool more = di >= 0 || k > zeroFrom;
                    ib.Insert(0, more ? ',' : ' ');
                    continue;
                }
                if (di >= 0) { ib.Insert(0, intDigits[di--]); continue; }
                ib.Insert(0, k >= zeroFrom ? '0' : ' ');
            }
            string body = ib.ToString();
            if (decimals > 0) body += "." + fracDigits;
            string lead = body.TrimStart(' '); int pad = body.Length - lead.Length;
            if (dollar) lead = "$" + lead;
            string signed;
            if (pr) signed = neg ? "<" + lead + ">" : lead + (fm ? "" : " ");
            else if (mi) signed = lead + (neg ? "-" : fm ? "" : " ");
            else if (sLead == 1) signed = (neg ? "-" : "+") + lead;
            else if (sLead == 2) signed = lead + (neg ? "-" : "+");
            else signed = (neg ? "-" : fm ? "" : " ") + lead;
            if (!started) signed = lead;
            return fm ? signed : new string(' ', pad) + signed;
        }
        // TO_CHAR(number) with no format: Oracle's shortest form (0.5 -> .5, -0.5 -> -.5, 3 -> 3).
        public static string NumberText(double v)
        {
            if (v == Math.Floor(v) && Math.Abs(v) < 1e15) return ((long)v).ToString(CultureInfo.InvariantCulture);
            string s = v.ToString("R", CultureInfo.InvariantCulture);
            if (s.StartsWith("0.")) s = s.Substring(1); else if (s.StartsWith("-0.")) s = "-" + s.Substring(2);
            return s;
        }
        // TO_NUMBER(text[, fmt]): group separators, currency and spaces are ignored; trailing minus / <..> negatives.
        public static bool ParseNumber(string s, string fmt, out double v)
        {
            v = 0; if (s == null) return false;
            string t = s.Trim();
            bool neg = false;
            if (fmt != null)
            {
                t = t.Replace("$", "");
                if (fmt.IndexOf(',') >= 0 || fmt.IndexOf('G') >= 0 || fmt.IndexOf('g') >= 0) t = t.Replace(",", "");
                if (t.StartsWith("<") && t.EndsWith(">")) { neg = true; t = t.Substring(1, t.Length - 2); }
                if (t.EndsWith("-")) { neg = true; t = t.Substring(0, t.Length - 1); }
                if (t.EndsWith("+")) t = t.Substring(0, t.Length - 1);
                t = t.Trim();
            }
            if (!double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return false;
            if (neg) v = -v;
            return true;
        }

        // ---------- dates: TRUNC / ROUND (d, fmt) ----------
        // Returns the truncated (or rounded) value; day: true when the result has no time of day.
        public static DateTime TruncDate(DateTime d, string fmt, bool round, out bool day)
        {
            string f = (fmt ?? "DD").Trim().ToUpperInvariant(); day = true;
            switch (f)
            {
                case "SYYYY": case "YYYY": case "YEAR": case "SYEAR": case "YYY": case "YY": case "Y": case "RRRR": case "RR":
                    { DateTime t = new DateTime(d.Year, 1, 1); if (round && d.Month >= 7) t = t.AddYears(1); return t; }
                case "Q":
                    { DateTime t = new DateTime(d.Year, (d.Month - 1) / 3 * 3 + 1, 1); if (round && (d.Month - t.Month > 1 || (d.Month - t.Month == 1 && d.Day >= 16))) t = t.AddMonths(3); return t; }
                case "MONTH": case "MON": case "MM": case "RM":
                    { DateTime t = new DateTime(d.Year, d.Month, 1); if (round && d.Day >= 16) t = t.AddMonths(1); return t; }
                case "WW": { DateTime y = new DateTime(d.Year, 1, 1); return Week(d, y, round); }
                case "IW":
                    { int back = ((int)d.DayOfWeek + 6) % 7; DateTime t = d.Date.AddDays(-back); if (round && (d - t).TotalDays >= 3.5) t = t.AddDays(7); return t; }
                case "W": { DateTime m = new DateTime(d.Year, d.Month, 1); return Week(d, m, round); }
                case "DDD": case "DD": case "J":
                    { DateTime t = d.Date; if (round && d.Hour >= 12) t = t.AddDays(1); return t; }
                case "DAY": case "DY": case "D":
                    { DateTime t = d.Date.AddDays(-(int)d.DayOfWeek); if (round && (d - t).TotalDays >= 3.5) t = t.AddDays(7); return t; }
                case "HH": case "HH12": case "HH24":
                    { day = false; DateTime t = new DateTime(d.Year, d.Month, d.Day, d.Hour, 0, 0); if (round && d.Minute >= 30) t = t.AddHours(1); return t; }
                case "MI":
                    { day = false; DateTime t = new DateTime(d.Year, d.Month, d.Day, d.Hour, d.Minute, 0); if (round && d.Second >= 30) t = t.AddMinutes(1); return t; }
            }
            throw new EngineException("FORMAT_INVALID", "Unknown TRUNC / ROUND date format '" + fmt + "' (use YYYY, Q, MM, WW, IW, W, DD, DAY, HH24 or MI).");
        }
        // Week starting on the weekday of 'from' (Jan 1 for WW, the 1st for W).
        static DateTime Week(DateTime d, DateTime from, bool round)
        {
            int k = (int)Math.Floor((d.Date - from).TotalDays / 7);
            DateTime t = from.AddDays(k * 7);
            if (round && (d - t).TotalDays >= 3.5) t = t.AddDays(7);
            return t;
        }

        // ---------- regular expressions ----------
        // Oracle match flags -> .NET options: i (ignore case), c (case sensitive), n (. matches newline), m (multi-line), x (ignore spaces).
        public static RegexOptions Flags(string f)
        {
            RegexOptions o = RegexOptions.CultureInvariant;
            if (f == null) return o;
            foreach (char ch in f)
            {
                switch (ch)
                {
                    case 'i': o |= RegexOptions.IgnoreCase; break;
                    case 'c': o &= ~RegexOptions.IgnoreCase; break;
                    case 'n': o |= RegexOptions.Singleline; break;
                    case 'm': o |= RegexOptions.Multiline; break;
                    case 'x': o |= RegexOptions.IgnorePatternWhitespace; break;
                }
            }
            return o;
        }
        static readonly string[][] Posix = {
            new[] { "[:alpha:]", "a-zA-Z" }, new[] { "[:digit:]", "0-9" }, new[] { "[:alnum:]", "a-zA-Z0-9" }, new[] { "[:upper:]", "A-Z" },
            new[] { "[:lower:]", "a-z" }, new[] { "[:space:]", "\\s" }, new[] { "[:blank:]", " \\t" }, new[] { "[:punct:]", "!-/:-@\\[-`{-~" },
            new[] { "[:xdigit:]", "0-9A-Fa-f" }, new[] { "[:cntrl:]", "\\x00-\\x1f\\x7f" }, new[] { "[:print:]", "\\x20-\\x7e" }, new[] { "[:graph:]", "\\x21-\\x7e" } };
        static readonly Dictionary<string, Regex> rxCache = new Dictionary<string, Regex>();
        public static Regex Rx(string pattern, string flags)
        {
            string key = (flags ?? "") + "\u0001" + pattern; Regex r;
            lock (rxCache) if (rxCache.TryGetValue(key, out r)) return r;
            string p = pattern;
            foreach (string[] x in Posix) p = p.Replace(x[0], x[1]);
            r = new Regex(p, Flags(flags));
            lock (rxCache) { if (rxCache.Count > 500) rxCache.Clear(); rxCache[key] = r; }
            return r;
        }
        // Oracle replacement text: \1..\9 are groups; $ is literal.
        public static string Replacement(string r) { return Regex.Replace((r ?? "").Replace("$", "$$"), @"\\([0-9])", "$${$1}"); }
    }
}
