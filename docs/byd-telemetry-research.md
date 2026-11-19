---
summary: "Research on what atto1 and the BYD ATTO 1 (Australia) share with BYD, which BYD privacy documents govern an AU owner, and the opt-outs that exist; cited, dated 2026-10-19"
read_when:
  - "working on the BYD telemetry privacy goal (issues #10 and #37)"
  - "deciding what data the BYD app or car sends to BYD and how to limit it"
  - "checking a claim about BYD's privacy policy, account deletion or opt-outs"
---

# BYD ATTO 1 (Australia): what data is shared with BYD, and the opt-outs

Researched 2026-10-19 by Aquila (WSL2) for issue #37 / #10. Every claim is followed by a
citation [n]. Unmarked claims come from a primary source: a BYD document, an app store
listing, OAIC, or repo source code. Press reporting is marked **[secondary]**, and my own
reasoning is marked **[inference]** or **[speculation]**.

---

## 0. Which documents govern an AU ATTO 1 owner (read this first)

Three BYD documents apply, and they are not the same document:

| Scope | Document | Controller / contact |
|---|---|---|
| Website only (bydautomotive.com.au) | *Privacy Policy*, "Last reviewed and updated: September 2026" [1] | BYD Australia Pty Ltd, info.au@byd.com |
| BYD mobile app + BYD account + car-to-app telematics | *Privacy Statement – BYD APP*, "applies since 30 July 2026" [3] | BYD AUSTRALIA PTY LTD, bydservice.au@byd.com / auto.asia@byd.com |
| The car itself (DiLink head unit) | An in-car privacy policy at *Vehicle Settings → System Settings → More → Privacy Policy* [6, p.27, p.30]. **Not published online, so not found.** | — |

- **Distributor history.** BYD Australia Pty Ltd took over passenger-car import and
  distribution from EVDirect from July 2025. EVDirect kept a stake in the retail joint
  venture EVDealer Group (EVDG) **[secondary]** [12]. The current policy names three
  dealer or distributor recipients: Harmony New Energy Auto Service (Australia) Pty Ltd,
  EVDealer Group Pty Ltd, and Quickoil Carsales Pty Ltd [1].
- **The previous AU policy is still live.** The pre-September-2026 policy (15 pages)
  remains published at a different URL [2]. It covered the website **and the BYD Auto App
  and vehicle telematics**. The September 2026 rewrite [1] narrowed scope to the website:
  "Our Privacy Policy covers https://bydautomotive.com.au/" [1]. ABC reports that the new
  policy "no longer applies to vehicles and points users to a separate app document"
  **[secondary]** [13].
- **EVDirect / EVDG policy.** An `ev-dealer-group-privacy-policy.pdf` was archived on
  bydautomotive.com.au in Nov 2022 (Wayback CDX). The live URL now returns an empty file
  [checked 2026-10-19]. I did not retrieve the archived copy's content.

## 1. BYD Australia privacy policies

### 1a. Current website policy (Sept 2026) [1]

- **Collected.** Only web-form data: name, mobile, email and postcode for test drives,
  enquiries and updates; VIN for customer feedback; careers data; finance-application data
  shared with Allied Retail Finance or Smartgroup; cookies, IP address and Google Maps
  approximate location [1]. It does **not** mention vehicle telemetry, location history,
  voice, or cameras [1].
- **Sharing.** Affiliates and subsidiaries ("to assist, operate, enhance, and fulfil
  services on our behalf"), the three dealers, finance providers, CFS Group (website
  development) and law enforcement. "We do not sell your personal data" [1].
- **Overseas transfer.** "Currently, your personal data is processed and stored within our
  data centers located in Australia. Should we need to transfer your personal data to other
  countries or regions in the future … we will comply with applicable data protection laws"
  [1]. It does not list any countries.
- **Retention.** No fixed periods: "not … longer than necessary" [1].
- **Rights and requests.** Access, portability, correction, deletion, restriction and
  objection. BYD aims to resolve requests "within 30 workdays of receipt" [1].
- **Contact.** info.au@byd.com, "Attention: The BYD Privacy Officer". Post: BYD Australia
  Pty Ltd, Suite 401, 2 Lyonpark Road, Macquarie Park NSW 2113 [1].

### 1b. Previous policy (still hosted, pre-Sept 2026) [2]

This is the policy most 2025-26 buyers would have accepted at purchase or app sign-up.
**[inference]** That follows from its date range. It has not been confirmed for any
individual buyer.

- **Scope.** "This policy applies to anyone who accesses any website or app of ours,
  including the BYD Auto App" [2].
- **Telematics.** "BYD Australia may also collect telematics log data from the BYD vehicle
  you purchased from us. The data may be collected via remote access or in person at a
  service appointment." Listed items: "vehicle status information including speed, battery
  and charging, odometer readings, vehicle mechanisms, Electronic Control Unit information;
  cellular data usage; other data to assist in identifying issues and analysing the
  performance of the vehicle" [2].
- **Navigation.** "If you use the map navigation systems in your BYD vehicle through an
  application (for example, Telanav Map), an BYD Australia entity may also collect …
  (VIN), real-time locations and address details" [2].
- **Other categories.** "photos, images and biometric information", "information found on
  social media", call recordings and transcripts, and "vehicle related data which may be
  automatically transmitted from your vehicle" [2].
- **Purposes.** These include "data analytics and market research", direct marketing, and
  "surveillance activities undertaken to assist in the protection of people, property and
  company assets … in connection with suspected illegal or improper activities" [2].
- **Overseas.** Recipients are "likely to include China, USA, UK, New Zealand, Japan,
  India, Germany, Canada, Singapore, Philippines, Czech Republic, Hong Kong, Spain, South
  Korea, Sweden or Malaysia". The policy also says "an overseas recipient may not be
  required to protect your information in a way that, overall, provides comparable
  safeguards" [2].
- **Resale.** If you sell the vehicle, your app data "will become immediately accessible
  to that third party" unless you tell BYD to unlink the account [2].
- **Access.** Free to request, but BYD "may apply an administration fee for providing
  access". Complaints go to the OAIC, and to AFCA for credit matters [2].
- **ABC on the rewrite** **[secondary]** [13]: BYD uploaded the new policy 1 h 16 min
  before sending it to Four Corners. BYD said "We haven't and would not transfer any data
  of Australians to the Chinese authorities." Both versions say vehicle data is stored in
  Australia.

## 2. BYD app: privacy statement, terms and third-party SDKs (AU)

The AU documents are served from BYD's public legal-notice page
`dilinkappoversea-au.byd.auto:8666/#/text/fileNotice?...`. That is the AU counterpart of
the privacy-policy URL the App Store and Play listings link to (the EU host) [7][8]. They
were read unauthenticated in a browser, with no login.

### 2a. Privacy Statement – BYD APP (AU, applies since 30 July 2026) [3]

- **Controller.** BYD AUSTRALIA PTY LTD [3].
- **Data collected** [3]:
  - **Account:** email, login password, "operation password" (control PIN), registration
    date.
  - **Vehicle:** VIN, "vehicle identifier (ICCID/IMEI)", type, colour, version, delivery
    date, plate.
  - **Vehicle Status:** charge, charging time and status, range, total mileage, gear, door,
    tyre-pressure and window status, seat ventilation, temperature and climate, all "with
    associated timestamps".
  - **Device:** brand and model, OS, "device identifier (IMEI/UDID/UUID)", device name,
    app version, network operator, signal strength, timezone, "vehicle Digital Key
    credentials".
  - **Location:** "vehicle location data and device location data".
  - **App Usage:** "clicks in app, features used, pages viewed".
  - **Vehicle Owner:** purchase documents for used-car transfers.
  - **NPS survey data.**
- **Purposes and legal basis** [3]:
  - Contract basis: remote control and car status, Vehicle Position, Digital Key,
    reservations, push notifications, dealer locator, and "AI Technician" (pseudonymised
    user ID, contract plus consent).
  - **Consent** basis: OTA upgrade service and NPS surveys.
  - Recall notices: legal obligation.
- **Recipients** [3]:
  - "Affiliates and subsidiaries" ("directly or indirectly, controls, is controlled by or
    is under common control with BYD"). **[inference]** BYD Auto Industry Co. in Shenzhen
    falls inside that definition.
  - "Cloud service provider-Amazon Web Service, Inc."
  - IT service providers, professional advisers, and law enforcement "in the country where
    the service is provided".
- **Transfers.** "The personal data we collect is stored within Australia" [3]. The
  statement does not explicitly rule out access from other countries.
- **Retention.** "only for as long as necessary". On deregistration, data is deleted or
  anonymised [3].
- **In-app opt-outs it names** [3]:
  - "Individual center → Settings → Use vehicle position" disables location collection.
    "If you disable this function, we cannot provide with you Vehicle Position service."
  - "Individual center → Account and security → deregister account": BYD will "stop
    providing you with services … and will anonymize your relevant Personal Data".
  - Consent-based processing can be withdrawn, which is not retroactive.
- **Privacy contact.** "data protection officer at [auto.asia@byd.com]", BYD Australia,
  Suite 102, Level 1, 2 Lyonpark Road, Macquarie Park NSW 2113 [3]. **[inference]** Note
  the mismatch with the website policy's Suite 401 / info.au@byd.com [1]. Send requests to
  both.

### 2b. Older AU app statement still served (softType=1, v1.0, 31 Oct 2022) [4]

- It says: "we may access from BYD's headquarters in China or BYD AUSTRALIA PTY LTD in
  Australia is supported for the provision of services … your information may be
  transferred to BYD in the countries other than your place of residence" [4].
- It lists "Could service provider-Amazon Web Service" [4].
- **[speculation]** What `softType=1` means (iOS, a different app build, or the car) is
  not documented. It is still served live as of 2026-10-19.

### 2c. Third-party SDKs in the app (AU notice, agreementType=5) [5]

| SDK | Purpose | Data BYD says the SDK collects |
|---|---|---|
| Shenzhen Hexun Huagu Information Technology Co. (JPush / Jiguang) | Push messages | IMEI, IDFA, Android ID, MAC, OAID; IP, Wi-Fi and base-station info; **latitude/longitude**; **installed-app list** |
| Beijing Bangcle Security Technology | Transport security / encryption | Model, IMEI, MAC, OS version |
| Google (Firebase Crashlytics) | Crash analysis | Installation UUIDs, crash traces |

BYD says: "We do not share your any personal data to the below third parties" [5].
**[inference]** That claim sits awkwardly beside the SDKs themselves collecting
location, device IDs and the installed-app list on two China-based processors' terms.

### 2d. User Agreement (AU, v1.0, 31 Oct 2022) [9]

- Account deregistration path: "Personal centre-Account and security-Account
  cancellation". Afterwards "existing data in your account will be permanently lost" [9].
- The deregistration notice adds: data "will be purged and cannot be recovered, but this
  will not affect your use of the vehicle". You can also email BYDcloudservice1@byd.com
  [10].
- "BYD Cloud Service" is a free trial from first delivery, then paid. The on-board
  terminal is "bound with a network service provider number", and you cannot choose that
  number [9].
- Data-subject requests are made "from within the application", and users must "moderate
  the frequency of requests" [9].
- Reverse engineering, decompiling and disassembling are prohibited [9]. This is relevant
  to §6.

## 3. App-store privacy declarations

| | iOS App Store (AU) [7] | Google Play (AU) [8] |
|---|---|---|
| Listing | "BYD AUTO" (BYD&DENZA&YANGWANG), id **1492400299**, v3.6.0 | "BYD AUTO", package **com.byd.bydautolink**, 1M+ downloads, updated 15 Oct 2026 |
| Developer | BYD Auto Industry Company Limited | BYD Auto Industry Company Limited |
| Tracking | No "Data Used to Track You" section | — |
| Linked to you / collected | Email address (App Functionality) | Email address (App functionality, Developer communications, Account management); Messages → Emails; Device or other IDs |
| Not linked / shared | Device ID (App Functionality) | **Shared**: Crash logs (Analytics) |
| Security | — | Encrypted in transit; deletion can be requested |
| Privacy-policy link | EU host `dilinkappoversea-eu.byd.auto:8666/...agreementType=2&softType=0` | Same EU host, `&country=NO` |

**[inference]** Both store labels omit precise location, vehicle data and app-usage data.
BYD's own AU privacy statement [3] and its SDK table [5] say the app collects all three.
The labels are self-declared ("not verified by Apple") and understate collection.

## 4. In-car settings (ATTO 1 Owner's Handbook, AU, 2025) [6]

Source: BYD Australia's official ATTO 1 handbook PDF, 184 pp. Page numbers are the
handbook's printed numbers.

- **Automatic upload (p.28).** "The vehicle has remote monitoring services … remote
  diagnosis and over-the-air (OTA) updates." Purposes: "service provision (remote
  support/diagnostics), product development, and security/public safety". "Depending on
  the country and setup, various vehicle information can be transmitted to BYD's data
  center in corresponding market … including **vehicle location information**, vehicle
  status, such as energy consumption, vehicle speed, gear position, power mode, ESC status,
  steering system status, battery status, powertrain status, and overall vehicle
  performance status" [6].
- **OBD data (p.28).** In-vehicle operation data is stored locally and read over OBD by
  dealers. During servicing it "can also be transmitted to BYD engineers for quality
  assurance, product defect reports, or customer claim verification" [6].
- **EDR (p.27).** Records only around a crash or near-crash: speed, tyre pressure, ACC
  status, seat-belt state. Reading it requires special equipment [6].
- **Offline mode (p.29).** "You can also restrict your vehicle's communication with the
  BYD data server and the processing of vehicle-related and personal data by setting the
  vehicle to offline mode." The only steps given are "tap [icon] to turn Wi-Fi off" or
  "System → System Settings → Interlink → WLAN → Off" [6].
  - **[inference]** This is incomplete. The ATTO 1 has a 4G "Network communication host"
    and "ECALL 4G Antenna" (p.177) [6], so turning WLAN off probably does not stop the
    cellular T-Box from uploading.
  - The handbook does not document any switch that disables the T-Box. A "mobile data
    connection" toggle exists in the shortcut menu (p.128) [6]. Whether it controls the
    head unit only or the T-Box too is not stated.
- **Driver monitoring camera (p.116).** "The original monitoring data will be deleted
  immediately after the judgment is completed, and will not be saved or uploaded to the
  server." Fatigue and distraction warnings toggle at "Settings → Vehicle → Cabin
  Perception". They are on by default and turn back on at each power-on [6].
- **Cameras (pp.28-29).** "Some images are just processed on a volatile basis (RAM),
  others may be stored." The car "may be equipped with" an outward-facing dashcam (OFC) and
  an inward-facing camera (IFC), and "Both OFC and IFC footage is stored." Nothing says
  where (local or cloud) [6].
- **Voice (p.130).** "Hi, BYD" wake word and a steering-wheel button. The handbook does not
  say whether recognition runs locally or in the cloud [6].
- **First boot (p.128).** "A warning is displayed when the Multimedia system starts for the
  first time. Tap Agree to enter the system." **[inference]** This is the in-car privacy
  consent gate; its text is not reproduced in the handbook [6].
- **OTA (pp.129-130).** OTA updates are user-initiated, either immediately or by
  appointment, from the screen or the app. The handbook frames remote monitoring and OTA as
  "subject to owner's approval" [6].
- **Resale (p.29).** A factory reset is recommended at "Settings → System → Version"
  (p.128) [6].
- **Third-party apps (p.28).** "BYD has no control over data transferred to third parties
  (from the use of third party content, in particular as part of online services)" [6].
- **Rights (p.30).** The handbook cites the GDPR and local law (access, erasure, objection,
  portability) and points to the in-car privacy policy [6].

**What each opt-out breaks** (from the cited text; inferences marked):

| Lever | Stops | Breaks |
|---|---|---|
| App: "Use vehicle position" off [3] | App location collection | Vehicle Position / find-my-car [3] |
| App: deregister account [3][9][10] | App-side processing; data anonymised or purged | All app features: remote A/C, lock, status, Digital Key, app OTA. The car still drives [10]. **[inference]** The T-Box keeps reporting to BYD's server whether or not an account exists |
| Withdraw OTA consent [3] | OTA via app | Software updates. **[inference]** Possibly recall fixes delivered by OTA |
| Car: WLAN off ("offline mode") [6] | Head-unit Wi-Fi traffic | Online head-unit features (smart voice, apps, video call; p.128) [6]. **[inference]** Does not stop the 4G T-Box |
| Car: mobile data toggle (p.128) [6] | Unknown | Unknown. Not documented |
| Physically disabling the T-Box / 4G | **[speculation]** All remote telemetry | **[speculation]** eCall, app, OTA. May affect warranty. Not documented by BYD |
| Cabin Perception off [6] | DMS warnings (already not uploaded per BYD) | Fatigue/distraction alerts; resets each power-on [6] |
| Privacy-law requests (§5) | Access/correction; deletion where no other legal basis | — |

## 5. Australian legal levers (Privacy Act 1988, APPs)

- **APP 12 (access).** Organisations must give access on request and respond "within a
  reasonable period" [14]. The OAIC treats that as 30 days. Asking is free, and any charge
  for access "can't be excessive". Refusals must be in writing with reasons and complaint
  options [15].
- **APP 13 (correction).** BYD must take reasonable steps to correct information that is
  inaccurate, out of date, incomplete, irrelevant or misleading, on the same response
  timeframe [14].
- **APP 11.2 (destroy or de-identify).** Required once the information is no longer needed
  for any permitted purpose [14]. Australia has no general "right to erasure"; BYD's
  policies offer deletion contractually [1][3].
- **APP 8 (cross-border).** Before disclosing personal information overseas, an entity must
  take reasonable steps to ensure the recipient does not breach the APPs (8.1). The
  exception is informed consent (8.2) [14].
  - Under s 16C the entity stays accountable for the overseas recipient's breaches [16].
  - Remote access from overseas is a "disclosure" once the overseas recipient "is able to
    access or modify" the information. Overseas cloud storage can be a "use" only where the
    entity keeps "effective control" [16].
  - **[inference]** HQ access from China, as described in [4], would be a disclosure under
    APP 8.
- **OAIC complaint route.** Complain to BYD first. If BYD does not respond within 30 days,
  or the response is unsatisfactory, lodge in writing via the online form, by email to
  oaicintake@oaic.gov.au, or by post to GPO Box 5288 Sydney NSW 2001 [17].
- **[secondary]** BYD told ABC it had "formally responded to preliminary inquiries" [13].
  The article does not say from which regulator.

**Suggested request** **[inference]**: an APP 12 access request to *both* info.au@byd.com
(Privacy Officer) [1] and auto.asia@byd.com (app DPO) [3], naming the VIN. Ask for:

- all telematics and T-Box data held, and the upload frequency;
- location history;
- the list of overseas recipients and the countries from which the data is accessed
  (APP 8);
- the in-car privacy policy text;
- how to disable T-Box upload without losing eCall.

## 6. Reverse-engineered BYD cloud clients (what an atto1 import would imply)

- **pyBYD** (jkaberg/pyBYD @ 995ef70) [18]:
  - **Login.** Logs in to `/app/account/login` with `functionType: "pwdLogin"` using the
    owner's **BYD account email or phone and password** [18a]. There is no OAuth and there
    are no scopes. It is full account-holder access, exactly like the app.
  - **Encryption.** The request is AES-encrypted with a key derived from the password and
    wrapped in a "Bangcle envelope … white-box AES" [18a][18b].
  - **Fake device.** It sends a fabricated device profile: IMEI, MAC, model ("POCO F1"),
    and so on [18c].
  - **Remote commands.** These additionally need the 6-digit control PIN, MD5-hashed
    [18c].
  - **Endpoints.** It reads realtime vehicle state and GPS (`/control/getGpsInfo`) [18d]
    and can lock, unlock, run climate and so on. It also uses MQTT push [18e].
  - **Region.** The default base URL is the EU host [18c].
- **hass-byd-vehicle** (jkaberg/hass-byd-vehicle @ 4112beb) [19]:
  - **AU endpoints.** The Australia region maps to `https://dilinkappoversea-au.byd.auto`
    and push `https://dilinkpush-au.byd.auto:8443`, country `AU` [19a].
  - **Device fingerprint.** It generates a randomized "realistic Android device
    fingerprint" with a Luhn-valid IMEI [19b].
  - **Dedicated account.** The README advises "Use an dedicated BYD account for the
    integration, that way you won't be logged out from the BYD app on your main account".
    So BYD allows one app session per account [19c].
  - **Battery.** "Frequent polling can cause noticeable battery drain" [19c].
- **Implications for an atto1 BYD import** **[inference]**:
  1. You would have to store the BYD account password, plus the control PIN if you want
     commands, which gives full lock and unlock power.
  2. Each poll is another server-side request logged against your VIN. It adds no
     privacy, and BYD already holds the data.
  3. It breaches the User Agreement's no-reverse-engineering clause [9] and impersonates
     a device.
  4. It can break without notice when the Bangcle tables or app version change.
  5. A safer alternative is a manual or CSV entry path, or a read-only second account
     without a control PIN, accepting single-session logout.

## What I could NOT find

- **In-car privacy policy.** The text at Vehicle Settings → System Settings → More →
  Privacy Policy is not published online [6].
- **Dolphin Surf / Seagull manuals.** No official BYD manual found. Only the AU ATTO 1
  handbook was used.
- **Undocumented in-car settings.** No BYD documentation of a "user experience improvement
  programme", a data-sharing toggle, or any switch that disables the T-Box/4G telematics on
  the ATTO 1.
- **Voice processing.** No statement of whether voice ("Hi, BYD") is processed on-device
  or in the cloud, or of voice-data retention.
- **Cameras.** No ATTO 1 documentation of sentry mode or DVR cloud upload. The handbook
  says only that OFC/IFC footage "is stored" [6].
- **Upload detail.** Frequency and granularity of T-Box uploads are undocumented: no
  location-trail interval, no retention period.
- **softType meaning.** Why the AU notice server still serves a 2022 statement with China
  HQ access [4], and what `softType` signifies.
- **BYD Cloud Service in AU.** The free-period length, and what happens to telemetry when
  it lapses.
- **Archived EVDirect / EVDG privacy policy.** The live URL is empty and the archived
  content was not retrieved.
- **ABC hack testing.** ABC's Shark 6 testing (live tracking, remote functions) was not
  verified here **[secondary]** [20]. It concerns a different model.

## Citations (all checked 2026-10-19)

1. BYD Australia, *Privacy Policy* (website), "Last reviewed and updated: September 2026" — https://bydautomotive.com.au/public/byd-auto-privacy-policy-2026.pdf (linked from https://bydautomotive.com.au/privacy-policy) — checked 2026-10-19
2. BYD Australia Pty Ltd, *Privacy Policy* (previous, 15 pp., covers BYD Auto App) — https://bydautomotive.com.au/public/byd-auto-privacy-policy.pdf (byte-identical to Wayback capture 2025-08-25: https://web.archive.org/web/20250825202043/https://bydautomotive.com.au/public/byd-auto-privacy-policy.pdf) — checked 2026-10-19
3. BYD Australia, *Privacy Statement – BYD APP* (applies since 30 July 2026) — https://dilinkappoversea-au.byd.auto:8666/#/text/fileNotice?agreementType=2&softType=0 — checked 2026-10-19
4. BYD Australia, *Privacy Statement of BYD* v1.0 (31 Oct 2022) — https://dilinkappoversea-au.byd.auto:8666/#/text/fileNotice?agreementType=2&softType=1 — checked 2026-10-19
5. BYD, *Third Party Services* (AU) — https://dilinkappoversea-au.byd.auto:8666/#/text/fileNotice?agreementType=5&softType=0 — checked 2026-10-19
6. BYD, *ATTO 1 Owner's Handbook* (AU, 2025), pp. 27-30, 116, 128-132, 177 — https://bydautomotive.com.au/brochures/BYD-ATTO-1-Owners-Handbook-2025.pdf (linked from https://bydautomotive.com.au/atto-1) — checked 2026-10-19
7. Apple App Store (AU), "BYD AUTO" id1492400299, App Privacy section — https://apps.apple.com/au/app/byd-auto/id1492400299 — checked 2026-10-19
8. Google Play (AU), "BYD AUTO" com.byd.bydautolink, listing and Data safety — https://play.google.com/store/apps/details?id=com.byd.bydautolink&hl=en&gl=AU and https://play.google.com/store/apps/datasafety?id=com.byd.bydautolink&hl=en&gl=AU — checked 2026-10-19
9. BYD, *User Agreement of BYD* v1.0 (31 Oct 2022), AU — https://dilinkappoversea-au.byd.auto:8666/#/text/fileNotice?agreementType=1&softType=0 — checked 2026-10-19
10. BYD, account de-registration notice (AU) — https://dilinkappoversea-au.byd.auto:8666/#/text/fileNotice?agreementType=3&softType=0 — checked 2026-10-19
11. BYD Europe, *Privacy Statement – BYD Application* v3.1 (Apr 2024), the EU URL the stores link — https://dilinkappoversea-eu.byd.auto:8666/#/text/fileNotice?agreementType=2&softType=0 — checked 2026-10-19 (context only; served in French to this client)
12. [secondary] 4X4 Australia, "BYD ends EVDirect partnership, takes full control of Australian distribution" — https://www.4x4australia.com.au/news/byd-ends-evdirect-partnership-takes-full-control-of-australian-distribution — checked 2026-10-19 (via search summary)
13. [secondary] ABC News, "EV manufacturer BYD scrubs references to 'China' and 'surveillance' from its privacy policy", 22 Sep 2026 — https://www.abc.net.au/news/2026-09-22/byd-ev-privacy-policy-update-china-surveillance-four-corners/107168584 — checked 2026-10-19
14. OAIC, *Read the Australian Privacy Principles* (APP 8, 11, 12, 13) — https://www.oaic.gov.au/privacy/australian-privacy-principles/read-the-australian-privacy-principles — checked 2026-10-19
15. OAIC, *Access your personal information* — https://www.oaic.gov.au/privacy/your-privacy-rights/your-personal-information/access-your-personal-information — checked 2026-10-19
16. OAIC, *APP Guidelines Chapter 8* (paras 8.8-8.15, 8.60-8.63) — https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-8-app-8-cross-border-disclosure-of-personal-information — checked 2026-10-19
17. OAIC, *Lodge a privacy complaint with us* — https://www.oaic.gov.au/privacy/privacy-complaints/lodge-a-privacy-complaint-with-us — checked 2026-10-19
18. jkaberg/pyBYD @ 995ef70a2b6bd287d58c1f8564e6b50eabc7f868 — https://github.com/jkaberg/pyBYD — checked 2026-10-19
    - a. `src/pybyd/_api/login.py` (build_login_request, `pwdLogin`, `/app/account/login`)
    - b. `src/pybyd/_crypto/bangcle.py` ("Bangcle envelope encoding/decoding using white-box AES")
    - c. `src/pybyd/config.py` (DeviceProfile, BydConfig: username/password/control_pin, default `base_url`)
    - d. `src/pybyd/_api/gps.py` (`/control/getGpsInfo`)
    - e. `README.md` (MQTT, remote commands, control PIN)
19. jkaberg/hass-byd-vehicle @ 4112beb5b50c302686758e6028745af44d3de3b9 — https://github.com/jkaberg/hass-byd-vehicle — checked 2026-10-19
    - a. `custom_components/byd_vehicle/const.py` (lines 68-70 Australia endpoints; line 148 `"Australia": ("AU", "en")`)
    - b. `custom_components/byd_vehicle/device_fingerprint.py`
    - c. `README.md` ("Initial setup", "After setup")
20. [secondary] ABC News, "We got a cybersecurity expert to hack this BYD. It was too easy", 21 Sep 2026 — https://www.abc.net.au/news/2026-09-21/byd-hacked-by-cybersecurity-expert-vehicle-sabotage-surveillance/107139482 — checked 2026-10-19 (title/search summary only, not read)
