# Hermosa OS versions

Pre-launch numbering: **v0.NN.P**. NN = the latest database update (`update-00NN.sql`) the code needs; P = app-only releases after it (no SQL). Launch = v1.0.0.

| Version | Date (Manila) | Needs SQL | What changed |
| --- | --- | --- | --- |
| 0.33.1 | Nov 25, 2026 | none | View as is back for the General Manager on laptops: the button now sits above the menu, and a long menu scrolls inside the sidebar instead of pushing View as (and the sign-out row) below the screen |
| 0.33.0 | Nov 25, 2026 | update-0033 | Owners and the General Manager can set or correct any staff member's start date on the employee's page (Employees > name > Start date); the date shows under the name and every change is logged |
| 0.32.3 | Nov 25, 2026 | none | Time clock works in the Messenger in-app browser and older phones: the photo name no longer needs crypto.randomUUID (the "Something went wrong" Saralyn and Vanessa saw) |
| 0.32.2 | Nov 25, 2026 | none | Users and roles: staff split into Active and Inactive sections; Employees: inactive records moved to their own Inactive section at the bottom |
| 0.32.1 | Nov 25, 2026 | none | Time clock: if Hermosa OS is updated while the clock page is open, Time in / Time out no longer fails with "Something went wrong"; the page reloads itself and finishes the punch with the photo already taken. A photo the phone can't read now says so instead of a general error, and errors show a Reload button |
| 0.32.0 | Nov 25, 2026 | update-0032 | Late NTE deadline: explain within 2 scheduled working days counting the late day (until the end of the next scheduled working day); the time left counts down on Home, the time clock and Late NTEs; no explanation by then issues an IR automatically (urgent for the employee, management told); IRs issued automatically say "Issued by: Hermosa OS (automatic)" |
| 0.31.0 | Nov 25, 2026 | update-0031 | Employees get a Home notice when management decides: staff details approved or sent back; commission signed off ("Your commission amounting to ₱X has been approved and will be included in this cutoff's pay", with a Check your current commission total button opening the drilldown); entry not approved, with the reason. Salary payout section and My details say salaries are paid in cash by default and bank accounts are for records only |
| 0.30.0 | Nov 25, 2026 | update-0030 | Tardiness: 15-minute grace; IR suggested at 3 Late NTEs or once over 60 minutes late in the month; every late time-in makes a Late NTE the employee must explain (urgent on Home and the time clock); tardiness tracker per staff on owner/GM Home and Late NTEs page; person's NTE page asks "issue an IR?"; IR acknowledged online with a response (urgent notice); IR saved as photo and kept as PDF in private storage; automatic cutoff-minutes IR drafts stopped |
| 0.29.0 | Nov 25, 2026 | update-0029 | Every staff record has a UID (ST-0001) and every login account a UID (AC-0001), shown on Employees, Users and roles, Join requests, Staff details, On Duty, attendance, Time-in photos and My details, so invalid or duplicate records can be named and cleaned up |
| 0.28.0 | Nov 25, 2026 | update-0028 | General Manager gives every owner-level approval: staff details (not her own), join requests at every level except Owner, sales changes, Closed / No sales days, sales imports; staff details list no longer repeats a person and shows emails when names match; View as list fits laptop screens |
| 0.27.0 | Nov 25, 2026 | update-0027 | General Manager can accept or reject join requests on a new Join requests page; owner-level accounts stay owner-only |
| 0.26.2 | Nov 25, 2026 | none | Service log: staff who are not on commission no longer see commission choices |
| 0.26.1 | Nov 25, 2026 | none | Version shown at the bottom of every page |
| 0.26.0 | Nov 25, 2026 | update-0026 | Photo's own time saved with each time-in, "Old photo" flag, Time-in photos page with download; clock photo at 1024 px; time clock never hangs on location/upload |
| 0.25.1 | Nov 25, 2026 | none | Hosting moved to Cloudflare (hermosaos.com); details form per owner checklist; time clock uses back camera; phone location fixed |
| 0.25.0 | Nov 25, 2026 | update-0025 | Suggest a week, schedule checks and rules, Trainee level |
| 0.24.0 | Nov 25, 2026 | update-0024 | Schedule by branch, VL/SL/Absent, copy last week |
| 0.23.0 | Nov 25, 2026 | update-0023 | Tardiness incident reports |
| 0.22.0 | Nov 25, 2026 | update-0022 | Schedule, swaps, time clock, On Duty |
