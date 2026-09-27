# Til Player — ingliz tilini video orqali oʻrganish

Inglizcha video va subtitr (SRT/VTT) bilan ishlaydigan Android pleyer. Listening, shadowing va lugʻat boyitish uchun moʻljallangan.

## Imkoniyatlar

- **Kutubxona** — qoʻshilgan videolar va subtitrlar ilova ichida saqlanadi (internet shart emas). Har bir video qayerda toʻxtaganingizni eslab qoladi.
- **Subtitr rejimlari** (`CC` tugmasi): `EN` → `EN+UZ` → `Yashirin` (bosganda koʻrinadi) → `Oʻchiq`.
- **Soʻz tarjimasi** — subtitrdagi istalgan soʻzni bossangiz, oʻzbekcha tarjimasi, soʻz turkumlari boʻyicha maʼnolari va talaffuzi chiqadi. Qoʻshni soʻzlarni belgilab, butun iborani yoki gapni tarjima qilish mumkin.
- **Lugʻat** — saqlangan soʻzlar misol gap va video vaqti bilan saqlanadi; kartochkalar orqali takrorlash mumkin.
- **Listening** — subtitr yashiriladi, har gapdan keyin video toʻxtaydi. Qayta eshitish, diktant yozish va tekshirish.
- **Shadowing** — har gapdan keyin gap uzunligiga mos pauza beriladi; har bir gapni 1–5 marta takrorlash, oʻz ovozingizni yozib, asl talaffuz bilan solishtirish.
- Tezlik (0.5×–1.5×), gapni aylantirib takrorlash, oldingi/keyingi gapga oʻtish, subtitr sinxronini sozlash, toʻliq ekran.
- **Ikki tilli subtitrlar** — har bir inglizcha qator ostida oʻzbekcha tarjimasi yozilgan SRT faylni ilova oʻzi taniydi va ajratadi. Gap tarjimasi internetsiz, darhol chiqadi: subtitr yonidagi `UZ` tugmasi, `EN+UZ` rejimi, matndagi “Tarjima” belgisi, soʻz oynasi, diktant va shadowing’da.
- Alohida oʻzbekcha subtitr faylini qoʻshish ham mumkin.
- `[shamol esadi]` kabi tovush effekti qatorlari listening va shadowing’da oʻtkazib yuboriladi (sozlamalarda oʻchirsa boʻladi).

Tarjima Google Translate (zaxira: MyMemory) orqali olinadi va qurilmada keshlanadi — bir marta tarjima qilingan soʻz keyin internetsiz ham ochiladi.

## APK’ni yuklab olish

Har bir `push`dan keyin GitHub Actions APK yigʻadi:

1. GitHub’dagi repozitoriyada **Actions** → **APK yig'ish** → oxirgi muvaffaqiyatli ishga tushirishni oching.
2. Pastdagi **Artifacts** boʻlimidan `TilPlayer-apk` ni yuklab oling (zip ichida `TilPlayer.apk`).
3. Telefonda APK’ni oching va “Nomaʼlum manbalardan oʻrnatish”ga ruxsat bering.

`v1.0.0` kabi teg qoʻyilsa, APK avtomatik ravishda **Releases** boʻlimiga ham joylanadi.

## Tuzilishi

```
www/                 Ilovaning oʻzi (HTML/CSS/JS, freymvorksiz)
  js/app.js          Interfeys, pleyer, listening/shadowing mantigʻi
  js/subtitles.js    SRT/VTT tahlili, diktant tekshiruvi
  js/translate.js    Tarjima va kesh
  js/db.js           IndexedDB (videolar, lugʻat, sozlamalar)
  js/media.js        Talaffuz (TTS), ovoz yozish, ekran yoʻnalishi
android/             Capacitor tomonidan yaratilgan Android loyiha
.github/workflows/   APK yigʻish
```

## Mahalliy ishga tushirish

Brauzerda sinash:

```bash
npm install
npm run serve        # http://localhost:8080
```

APK yigʻish (Android SDK va JDK 21 kerak):

```bash
npm install
npm run build:apk    # android/app/build/outputs/apk/debug/app-debug.apk
```

## Maslahatlar

- Eng yaxshi moslik uchun videolar **MP4 (H.264 + AAC)** formatida boʻlsin.
- Subtitr kechiksa yoki oldinda boʻlsa, pleyerdagi `⋮` menyusidan sinxronni ±0.1 / ±0.5 soniyaga suring.
- Klaviatura (kompyuterda): `Space` — ijro/pauza, `←/→` — oldingi/keyingi gap, `Shift+←/→` — 5 soniya, `R` — gapni qayta, `L` — aylantirish, `S` — subtitr rejimi, `F` — toʻliq ekran.
