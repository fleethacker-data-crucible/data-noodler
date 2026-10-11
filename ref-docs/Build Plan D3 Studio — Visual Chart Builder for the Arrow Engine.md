# Build Plan: D3 Studio — Visual Chart Builder for the Arrow Engine

Oct 10, 2026 · @Christopher Staggs

## How to use this document

Opus: this is your build plan for D3 Studio, the visual chart builder that sits on top of the Arrow analytics engine from the companion build plan. Work through the phases **in order**; build what each phase specifies, run its **Checkpoint**, fix every failure, and report results to Chris before starting the next phase.

**The one principle everything depends on:** the Studio does not generate D3 code. It generates a **chart spec**, a small JSON document that describes the chart's marks, axes, scales, and named **data slots**. One renderer turns any spec into a live D3 chart. Binding data means mapping `table.field` to a slot name; nothing else changes. This is why a non-programmer can draw a chart, save it, and connect data without touching code, and why a chart drawn once works on any table with compatible columns.

A previous attempt generated per-chart D3 code directly. Do not repeat that: generated code cannot be re-edited in the Studio, every chart carries its own copy of the same scaffolding, and data binding has to be re-wired per chart. Spec in, chart out.

**Hard constraints:** same as the engine plan. No downloaded libraries except D3 itself if a local copy already exists on the machine; otherwise the renderer uses a hand-written subset of D3 (scales, axes, line/area/arc generators, selections) which is well within scope. Plain HTML, CSS and JavaScript, no build step, no framework. All data arrives from the engine as Arrow IPC batches over HTTP, decoded by the reader built in Phase 6 of the engine plan.

**Existing work:** Chris already has charts rendering and a binding convention where a UI assigns `table.field` to a named variable per axis. Keep that convention; this plan formalizes it as the spec's `slots` and makes it the only way data enters a chart.
