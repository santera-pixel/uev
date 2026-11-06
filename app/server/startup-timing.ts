/**
 * Startup phase timing for the control plane.
 *
 * Every expensive step between process spawn and "ready" records a mark once; the control API
 * reports them from /api/health so a slow cold start can be attributed to a phase instead of
 * guessed at. Marks are cheap (a Date.now and a Map lookup) and never rewind, so the first
 * occurrence wins.
 */

const processStartMs = Date.now() - Math.round(process.uptime() * 1000)
const marks = new Map<string, number>()

export interface StartupPhase {
	name: string
	/** Milliseconds from process spawn to this mark. */
	atMs: number
	/** Milliseconds spent between the previous mark and this one. */
	sincePreviousMs: number
}

export interface StartupReport {
	bootAt: string
	/** Milliseconds from process spawn to now. */
	elapsedMs: number
	phases: StartupPhase[]
}

/** Record a startup phase mark. The first call for a name wins. */
export const markStartup = (name: string): void => {
	if (!marks.has(name)) {
		marks.set(name, Date.now())
	}
}

/** Mark a phase whose duration was measured by the caller (catalog build, editor probe, ...). */
export const markStartupDuration = (name: string, durationMs: number): void => {
	if (!marks.has(name)) {
		marks.set(name, Date.now() - Math.max(0, Math.round(durationMs)))
	}
}

export const startupReport = (): StartupReport => {
	const phases: StartupPhase[] = []
	let previous = processStartMs
	for (const [name, at] of [...marks.entries()].sort((left, right) => left[1] - right[1])) {
		phases.push({ name, atMs: at - processStartMs, sincePreviousMs: at - previous })
		previous = at
	}

	return {
		bootAt: new Date(processStartMs).toISOString(),
		elapsedMs: Date.now() - processStartMs,
		phases,
	}
}

/** One log line summarising the phases recorded so far. */
export const startupSummary = (label = "UEV startup"): string => {
	const report = startupReport()
	const phases = report.phases.map((phase) => phase.name + "=" + phase.atMs + "ms").join(" ")
	return label + ": " + (phases || "no phases") + "; elapsed=" + report.elapsedMs + "ms"
}
