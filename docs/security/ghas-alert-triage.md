# GHAS alert triage (sprint 2026-11)

Open code-scanning alerts from the 2026-11-13 export. Alerts were not dismissed on GitHub.

| Alert | Rule | Path | Disposition | Reason |
|---|---|---|---|---|
| code-scanning #4 | js/xss-through-dom | ui/js/widgets/settings-panel.js | fixed | Setting labels, values, and slider min/max/step are escaped before they are written with innerHTML. A number is unchanged; a string can no longer break out of the markup. |
| code-scanning #3 | js/xss-through-dom | ui/js/widgets/color-picker.js | fixed | The swatch label is set with textContent and the chip colour with the CSS background property, so a stored or typed colour is not parsed as HTML. |
| code-scanning #2 | js/xss-through-dom | ui/html/project_manager.html | fixed | Sort-header text read from the DOM is passed through UI.esc before it is written back as HTML. The arrow markup is still a fixed string. |
| code-scanning #1 | js/incomplete-sanitization | ui/js/pipeline/sql-editor.js | fixed | Comment toggling removes a leading `//` or `--` with string checks. It no longer builds a regular expression by escaping only `/`. |

Nothing in this set is accepted. No GitHub dismissal reason is recommended.
