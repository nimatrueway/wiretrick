// Prints the release notes for a version: its CHANGELOG.md section, with
// relative links made absolute at the tag, plus a pointer to the install
// docs. Exits 1 when the section is missing or empty.
//
//   node scripts/release-notes.mjs 0.9.5 [owner/repo]
import { readFileSync } from "node:fs";

// GitHub renders a release body's single newlines as line breaks: join
// wrapped lines back into their paragraph or list item (code blocks kept).
function unwrap(md) {
    const out = [];
    let fence = false;
    for (const line of md.split("\n")) {
        if (line.startsWith("```")) fence = !fence;
        const prev = out[out.length - 1];
        const cont = !fence && line.trim() && !/^\s*([-*#|>]|\d+\.|```)/.test(line)
            && prev?.trim() && !/^(#|```|\|)/.test(prev);
        if (cont) out[out.length - 1] = `${prev} ${line.trim()}`;
        else out.push(line);
    }
    return out.join("\n");
}

export function releaseNotes(changelog, version, repo = "nimatrueway/wiretrick") {
    const lines = changelog.split("\n");
    const start = lines.findIndex(l => l.startsWith(`## [${version}]`));
    if (start < 0) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
    let end = lines.findIndex((l, i) => i > start && /^## |^\[[^\]]+\]: /.test(l));
    if (end < 0) end = lines.length;
    const body = lines.slice(start + 1, end).join("\n").trim();
    if (!body) throw new Error(`CHANGELOG.md section for ${version} is empty`);
    const base = `https://github.com/${repo}/blob/v${version}/`;
    const abs = unwrap(body).replace(/\]\((?![a-z]+:|#)([^)]+)\)/g, (_, p) => `](${base}${p})`);
    const prev = lines.slice(end).map(l => l.match(/^## \[(\d[^\]]*)\]/)?.[1]).find(Boolean);
    return [
        abs,
        "",
        `**Install:** see [docs/install.md](${base}docs/install.md).`,
        prev ? `**Full changelog:** https://github.com/${repo}/compare/v${prev}...v${version}` : "",
    ].join("\n").trim() + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [version, repo] = process.argv.slice(2);
    if (!version) { console.error("usage: release-notes.mjs <version> [owner/repo]"); process.exit(2); }
    try {
        process.stdout.write(releaseNotes(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), version, repo));
    } catch (e) {
        console.error(`::error::${e.message}`);
        process.exit(1);
    }
}
