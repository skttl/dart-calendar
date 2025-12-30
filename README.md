# Dart Calendar ICS API

This project provides an ICS (iCalendar) feed for dart teams using the DDU Dart API. It is designed to be deployed as a serverless function (e.g., Cloudflare Workers) and allows users to subscribe to team calendars in their favorite calendar apps.

## Features
- Fetches match schedules for one or more dart teams from the DDU Dart API
- Caches API responses for 30 minutes to reduce load and improve performance
- Generates an ICS calendar feed with:
  - Custom calendar name based on team names and league names
  - Non-overlapping events with accurate start and end times
  - Team IDs included in the PRODID for uniqueness
- Supports up to 10 team IDs per request

## Usage

### API Endpoint
```
GET /?teamIds=ID1,ID2,ID3
```
- `teamIds`: Comma-separated list of team IDs (required, 1–10 allowed)

Example:
```
https://<your-worker-url>/?teamIds=123,456
```

### Response
- Returns an ICS file (`text/calendar`) containing all games for the specified teams.

## Development

### Prerequisites
- Node.js
- Wrangler CLI (for Cloudflare Workers)

### Running Locally
```
wrangler dev
```

### Deploying
```
wrangler publish
```

## File Structure
- `src/index.js` – Main worker code
- `wrangler.toml` – Cloudflare Worker configuration

## License
MIT
