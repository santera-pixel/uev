export function Template(tmpl: string, vars: Record<string, string> = {}) {
	// Evaluate each ${...} expression on its own and splice it into the raw text.
	// The previous implementation wrapped the whole template in a JS template
	// literal, which silently rewrote every backslash escape in generated Python
	// (\n, \t, \x.., \r) and broke scripts that legitimately contain them.
	const keys = Object.keys(vars)
	const values = Object.values(vars)
	let output = ""
	let index = 0
	while (index < tmpl.length) {
		const start = tmpl.indexOf("${", index)
		if (start < 0) {
			output += tmpl.slice(index)
			break
		}
		output += tmpl.slice(index, start)
		let cursor = start + 2
		let depth = 1
		let quote: string | undefined
		while (cursor < tmpl.length) {
			const character = tmpl[cursor]
			if (quote) {
				if (character === "\\") {
					cursor += 2
					continue
				}
				if (character === quote) {
					quote = undefined
				}
				cursor += 1
				continue
			}
			if (character === "'" || character === '"' || character === "`") {
				quote = character
				cursor += 1
				continue
			}
			if (character === "{") {
				depth += 1
				cursor += 1
				continue
			}
			if (character === "}") {
				depth -= 1
				if (depth === 0) {
					break
				}
			}
			cursor += 1
		}
		const expression = tmpl.slice(start + 2, cursor)
		const value = new Function(...keys, `return (${expression});`)(...values)
		output += value === undefined ? "undefined" : String(value)
		index = cursor + 1
	}
	return output
}
