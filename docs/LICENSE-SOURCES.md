# License sources — state-by-state setup guide

> The license signal in the scorer fires when a candidate's normalised name (and optionally phone) matches a row in `state_licensees`. That table is populated by **manual CSV import** (per state-board TOS) using `POST /api/licenses/import`.

This document is the source-of-truth for which states are supported, where to download the official CSV, and which Keres niches it maps to.

---

## How the importer works

1. Operator downloads the official CSV from the state board (per links below).
2. Operator goes to *(Settings → Licenses)* in the UI **or** runs:
   ```bash
   curl -s -u :$AUTH_TOKEN \
     -X POST https://<keres>/api/licenses/import \
     -H 'content-type: application/json' \
     -d "$(jq -Rs --arg state TX --arg niche Septic --arg url https://www.tdlr.texas.gov/... '{state:$state, niche:$niche, csv:., sourceUrl:$url}' < licenses.csv)"
   ```
3. The importer accepts permissive column names (`Business Name` / `Legal Name` / `Company Name` / `Licensee`, `License #` / `Lic #` / `License Number`, `Status` / `Active`, `Expiration Date` / `Expires`, optional `Phone` / `City` / `Zip`).
4. Status is normalised into one of `active`, `expired`, `suspended` based on the source value.
5. Rows are upserted using `(state, license_number)` as the primary key when a license number is present; otherwise inserted with a name match.
6. Discovery then matches OSM-discovered businesses against `state_licensees` via:
   - phone-equality (strongest, 0.95 confidence)
   - normalised-name equality (0.9)
   - trigram similarity (0.55+ threshold, 0.85 ceiling)
7. The scorer's `license_active` signal triggers on match; `license_expired` triggers a negative weight.

Stale imports (`refreshed_at` > 180 days) automatically de-rate confidence by 0.2 so old data does not falsely boost scores.

---

## Texas — TDLR

| Niche | Trade type | Official source |
|---|---|---|
| Septic | On-Site Sewage Facility (OSSF) installers, designated reps, maintenance providers | https://www.tdlr.texas.gov/LicenseSearch/ |
| HVAC | Air Conditioning & Refrigeration Contractor (Class A/B) | https://www.tdlr.texas.gov/LicenseSearch/ |
| Plumber | (regulated by TSBPE, not TDLR) | https://www.tsbpe.texas.gov/Licensee-Records |
| Electrician | Electricians, Master Electricians | https://www.tdlr.texas.gov/LicenseSearch/ |
| Roofer | (no state license required in TX) | n/a |

**Download path:** TDLR publishes **monthly extract CSVs** at https://www.tdlr.texas.gov/LicenseSearch/Export/ (login required). Save the file as `tx-<niche>-YYYY-MM.csv` and import.

**Column hint:** TDLR CSVs use `License Number`, `License Status`, `Business Name`, `Expiration Date`, `Phone Number`, `City`, `Zip Code` — all already recognised by the importer.

---

## Florida — DBPR / Department of Business and Professional Regulation

| Niche | License type | Source |
|---|---|---|
| Septic | (Dept of Health) | https://www.flhealthsource.gov/ |
| HVAC | Class A/B Air Conditioning Contractor | https://www.myfloridalicense.com/datamart.asp |
| Plumber | Certified/Registered Plumber | https://www.myfloridalicense.com/datamart.asp |
| Electrician | Certified/Registered Electrical Contractor | https://www.myfloridalicense.com/datamart.asp |
| Roofer | Certified/Registered Roofing Contractor | https://www.myfloridalicense.com/datamart.asp |

**Download path:** DBPR DataMart → "Active Licensees by License Type" → CSV. One file per niche.

---

## Georgia — Sec. of State Professional Licensing

| Niche | Source |
|---|---|
| HVAC, Plumbing, Electrical | https://verify.sos.ga.gov/ |
| Septic | (county-level, not state) |
| Roofing | (no state license required in GA) |

**Download path:** verify.sos.ga.gov → search by profession → "Download Results" → CSV. The CSV uses `Licensee`, `License Type`, `Status`, `Expiration` — recognised by the importer.

---

## California — Contractors State License Board (CSLB)

| Niche | Classification | Source |
|---|---|---|
| Septic | C-42 Sanitation System Contractor | https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx |
| HVAC | C-20 Warm-Air Heating, Ventilating & Air-Conditioning | (same) |
| Plumber | C-36 Plumbing | (same) |
| Electrician | C-10 Electrical | (same) |
| Roofer | C-39 Roofing | (same) |

**Download path:** CSLB publishes a **License Data Download** (fixed-width text) at https://www.cslb.ca.gov/LicensingDownloads/. Convert to CSV before importing.

**Column hint:** `Business Name`, `License No`, `Status`, `Class`, `Expiration Date`, `Business Phone`, `Business City`, `Business Zip` — all recognised by the importer (alias support in `COL`).

**Caveat:** CSLB lists *contractors*, not necessarily corporations. Sole proprietors appear with their personal legal name; cross-match to the OSM business name carefully (prefer phone match where possible).

**Freshness:** CSLB updates the dump weekly.

**Status mapping:** `Active` → `active`; `Suspended`, `Probation` → `suspended`; `Expired`, `Inactive`, `Cancel` → `expired`.

**Scoring impact:** `+10` for active match in TX/FL/GA/CA when niche-licensed; `-25` for expired/suspended.

---

## Arizona — Registrar of Contractors (ROC)

| Niche | Classification | Source |
|---|---|---|
| Septic | C-42 Septic Tanks & Sewers | https://roc.az.gov/contractor-search |
| HVAC | C-39 Heating, Ventilating, Refrigeration & Evaporative Cooling | (same) |
| Plumber | CR-37 / C-37 Plumbing | (same) |
| Electrician | CR-11 / C-11 Electrical | (same) |
| Roofer | CR-42 / C-42 Roofing | (same) |

**Download path:** ROC contractor search offers **Export to Excel/CSV**. Run one export per niche × status (active + suspended), import each file.

**Column hint:** `Business Name`, `License Number`, `License Status`, `Expiration Date`, `Business Phone`, `Business City`, `Business Zip Code`.

**Caveat:** Residential (`CR-*`) and commercial (`C-*`) are separate licenses; for AI-receptionist outreach we typically care about residential — filter by `CR-*` codes when downloading.

**Freshness:** ROC updates daily.

**Status mapping:** `Active` → `active`; `Suspended`, `Revoked` → `suspended`; `Expired`, `Cancelled` → `expired`.

---

## North Carolina — multiple boards (per trade)

NC does *not* have a single contractor licensing body. Each trade is regulated separately:

| Niche | Board | Source |
|---|---|---|
| Septic | DEQ — On-Site Wastewater Section | https://www.deq.nc.gov/onsitewater |
| HVAC | NC Board of Examiners of Plumbing, Heating & Fire Sprinkler | https://www.nclicensing.org/licensee-search/ |
| Plumber | (same as HVAC) | (same) |
| Electrician | NC Board of Examiners of Electrical Contractors | https://www.ncbeec.org/contractor-search/ |
| Roofer | NC Licensing Board for General Contractors | https://www.nclbgc.org/licensee-search |
| Water/Mold | (no state board) | n/a |

**Download path:** Most boards offer search-results CSV export. DEQ septic requires manual download from a separate portal.

**Column hint:** Variable; the importer alias map handles `Licensee`, `License No`, `Status`, `Expires`, `Phone`, `City`, `ZIP`.

**Caveat:** Plumbing & HVAC share a board — pass `niche: HVAC` vs `niche: Plumber` to keep them separated in `state_licensees`.

**Freshness:** Varies per board (daily to monthly).

**Status mapping:** `Active` → `active`; `Suspended`, `Disciplined`, `Probation` → `suspended`; `Inactive`, `Expired` → `expired`.

---

## Tennessee — Department of Commerce & Insurance

| Niche | Source |
|---|---|
| Septic | TN Dept. of Environment & Conservation — https://www.tn.gov/environment/program-areas/wr-water-resources/water-quality/subsurface-sewage-disposal-systems.html |
| HVAC | Board for Licensing Contractors — https://verify.tn.gov/ |
| Plumber | (same) |
| Electrician | (same) |
| Roofer | (same) |

**Download path:** verify.tn.gov supports CSV export from search results. One export per classification.

**Column hint:** `Name on License`, `License Number`, `Status`, `Expiration`, `Phone`, `City`.

**Caveat:** TN licenses contractors above a monetary threshold (currently $25k+ for HVAC/Plumbing). Smaller operators may not appear; absence of a license row does *not* mean the business is illegitimate — treat as `unknown`, not negative.

**Freshness:** Daily.

**Status mapping:** `Active` → `active`; `Suspended` → `suspended`; `Expired` → `expired`; `Pending` → `unknown`.

---

## Importer behaviour for new states

For all four states above, the column-alias map in `apps/server/src/services/license-importer.ts::COL` already accepts the common header names plus a small expansion added in this cycle (e.g. `License No`, `Name on License`, `License Status`, `Business City`, `Business Zip`, `Business Phone`, `Class`, `ZIP`).

The importer is **state-agnostic** beyond the `state` field — the operator passes `state: 'CA' | 'AZ' | 'NC' | 'TN'` and the niche.

For any state we have not modelled yet, the importer still works — pass `state: 'XX'` and the discovery service will simply not pick up the active-license bump until you import a CSV.

---

## Compliance reminders

- **Never** scrape state board websites that have robots.txt or TOS restrictions on automated access. The CSV-import path exists precisely so we respect those.
- Some states publish licensee phone numbers as "do-not-call". Treat them as one data point, not as a green light to call.
- License data does **not** confirm the business has consented to receive cold email. CAN-SPAM, Gmail bulk-sender rules, and the launch gate still apply.

---

## Testing the importer locally

```bash
curl -s --cookie keres_session=… \
  -X POST http://localhost:8080/api/licenses/import \
  -H 'content-type: application/json' \
  -d '{
    "state": "TX",
    "niche": "Septic",
    "csv": "Business Name,License Number,Status,Expiration Date\\nAcme Septic Co,ABC-12345,Active,2027-04-30",
    "sourceUrl": "https://www.tdlr.texas.gov/LicenseSearch/"
  }'
```

After import, run a discovery against `niche=Septic, state=TX` and confirm the matched leads carry `license_status='active'` in their signals.
