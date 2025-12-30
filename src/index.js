const TIMEZONE = "Europe/Copenhagen";
const API_CACHE_TTL = 1800; // 30 minutes
const ICS_CACHE_TTL = 900;  // 15 minutes

export default {
    async fetch(request, env, ctx) {
        const cache = caches.default;
        const cacheKey = new Request(request.url, request);

        // 1️⃣ Try cache first
        let cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
            return cachedResponse;
        }

        const url = new URL(request.url);

        // 2️⃣ Read query params
        const teamIdsParam = url.searchParams.get("teamIds");

        if (!teamIdsParam) {
            return new Response(
                "Missing required query params: teamIds",
                { status: 400 }
            );
        }

        // 3️⃣ Parse team IDs
        const teamIds = teamIdsParam
            .split(",")
            .map((id) => id.trim())
            .filter((id) => /^\d+$/.test(id));

        if (teamIds.length === 0 || teamIds.length > 10) {
            return new Response("Invalid number of teamIds (1–10 allowed)", {
                status: 400,
            });
        }

        // 4️⃣ Build API URLs
        const allGames = [];

        for (const teamId of teamIds) {
            const apiUrl =
                `https://api.dart-ddu.dk/kampprograms` +
                `?_sort=kampprogram_dato:asc,kampprogram_kampnr:asc` +
                `&_start=0&_limit=-1` +
                `&_where%5B_or%5D%5B0%5D%5Bkampprogram_hjemmehold.id%5D=${teamId}` +
                `&_where%5B_or%5D%5B1%5D%5Bkampprogram_udehold.id%5D=${teamId}`;

            const apiRequest = new Request(apiUrl);
            let apiResponse = await cache.match(apiRequest);
            if (!apiResponse) {
                try {
                    const fetched = await fetch(apiUrl);
                    if (!fetched.ok) {
                        return new Response(`API returned ${fetched.status} ${fetched.statusText}`, { status: 502 });
                    }
                    const data = await fetched.json();
                    apiResponse = new Response(JSON.stringify(data), {
                        headers: { "Cache-Control": `public, max-age=${API_CACHE_TTL}` },
                    });
                    ctx.waitUntil(cache.put(apiRequest, apiResponse.clone()));
                } catch (err) {
                    return new Response(`Failed to fetch or parse JSON for teamId ${teamId}: ${err}`, { status: 502 });
                }
            }

            let json;
            try {
                json = await apiResponse.json();
            } catch (err) {
                const text = await apiResponse.text().catch(() => "<unreadable>");
                return new Response(`Failed to parse JSON at ${apiUrl} for teamId ${teamId}: ${err && err.stack ? err.stack : err}\nResponse body: ${text}`, { status: 502 });
            }
            allGames.push(...json);
        }

        // 6️⃣ Build ICS
        // Gather unique team names and raekke_navn's

        const teamNames = new Set();
        const raekkeNavns = new Set();
        for (const game of allGames) {
            if (game.kampprogram_hjemmehold?.id && teamIds.includes(String(game.kampprogram_hjemmehold.id))) {
                if (game.kampprogram_hjemmehold?.hold_holdnavn) teamNames.add(game.kampprogram_hjemmehold.hold_holdnavn);
            }
            if (game.kampprogram_udehold?.id && teamIds.includes(String(game.kampprogram_udehold.id))) {
                if (game.kampprogram_udehold?.hold_holdnavn) teamNames.add(game.kampprogram_udehold.hold_holdnavn);
            }
            if (game.raekke_id?.raekke_navn) raekkeNavns.add(game.raekke_id.raekke_navn);
        }

        const calendarName = `${[...teamNames].join(", ")} (${[...raekkeNavns].join(", ")})`;

        const ics = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            `PRODID:-//DDU Dart Calendar [teamIds:${teamIds.join(",")}]//EN`,
            "CALSCALE:GREGORIAN",
            `X-WR-CALNAME:${foldICSLine(escapeICS(calendarName))}`,
            `X-WR-TIMEZONE:${TIMEZONE}`,
            buildVTimezone(),
        ];

        const seen = new Set();

        // Sort games by start date (just in case)
        const sortedGames = allGames
            .filter(g => g.kampprogram_dato)
            .slice()
            .sort((a, b) => new Date(a.kampprogram_dato) - new Date(b.kampprogram_dato));

        for (let i = 0; i < sortedGames.length; i++) {
            const game = sortedGames[i];
            const start = new Date(game.kampprogram_dato);
            const dtStart = toICSLocal(start);

            // Default DTEND to 2 hours after DTSTART
            let end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

            // If next game starts after this DTSTART but before this DTEND, set DTEND to next game's start
            if (i + 1 < sortedGames.length) {
                const nextStart = new Date(sortedGames[i + 1].kampprogram_dato);
                if (nextStart > start && nextStart < end) {
                    end = nextStart;
                }
            }
            const dtEnd = toICSLocal(end);

            const home = game.kampprogram_hjemmehold?.hold_holdnavn ?? "Home";
            const away = game.kampprogram_udehold?.hold_holdnavn ?? "Away";

            const uid = `${game.kampprogram_kampnr}-${dtStart}`;
            if (seen.has(uid)) continue;
            seen.add(uid);

            ics.push(
                "BEGIN:VEVENT",
                `UID:${uid}@dart-ddu.dk`,
                `DTSTAMP:${toICSUTC(new Date())}`,
                `DTSTART;TZID=${TIMEZONE}:${dtStart}`,
                `DTEND;TZID=${TIMEZONE}:${dtEnd}`,
                `SUMMARY:${foldICSLine(escapeICS(`${game.raekke_id.raekke_navn}: ${home} vs ${away}`))}`,
                "END:VEVENT"
            );
        }

        ics.push("END:VCALENDAR");

        const response = new Response(ics.join("\r\n"), {
            headers: {
                "Content-Type": "text/calendar; charset=utf-8",
                "Content-Disposition": "inline; filename=dart-kampprogram.ics",
                "Cache-Control": `public, max-age=${ICS_CACHE_TTL}`,
            },
        });

        // 7️⃣ Store in cache asynchronously
        ctx.waitUntil(cache.put(cacheKey, response.clone()));

        return response;
    },
};

// Helpers
function foldICSLine(line) {
    const max = 75;
    let result = "";
    while (line.length > max) {
        result += line.slice(0, max) + "\r\n ";
        line = line.slice(max);
    }
    return result + line;
}

function toICSUTC(date) {
    return date
        .toISOString()
        .replace(/[-:]/g, "")
        .split(".")[0] + "Z";
}

function toICSDate(date) {
    return (
        date
            .toISOString()
            .replace(/[-:]/g, "")
            .split(".")[0] + "Z"
    );
}
function toICSLocal(date) {
    // Format: YYYYMMDDTHHMMSS (no Z)
    return date.toISOString().replace(/[-:]/g, "").split(".")[0];
}

function escapeICS(text) {
    return text
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\n/g, "\\n");
}

function buildVTimezone() {
    return [
        "BEGIN:VTIMEZONE",
        `TZID:${TIMEZONE}`,
        "BEGIN:STANDARD",
        "TZOFFSETFROM:+0200",
        "TZOFFSETTO:+0100",
        "TZNAME:CET",
        "DTSTART:19701025T030000",
        "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
        "END:STANDARD",
        "BEGIN:DAYLIGHT",
        "TZOFFSETFROM:+0100",
        "TZOFFSETTO:+0200",
        "TZNAME:CEST",
        "DTSTART:19700329T020000",
        "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
        "END:DAYLIGHT",
        "END:VTIMEZONE",
    ].join("\r\n");
}