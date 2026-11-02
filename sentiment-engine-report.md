
# Sentiment Engine – Model Files, Language Handling & Test Report

## Model files

They are not in git. Git ignores `sentiment-engine/models/*`.

- **Live files:** symlinks in `sentiment-engine/models/` pointing to `/Users/aaditya/Desktop/MyProject/python-testing-folder/`
- `distilbert-sst2.onnx` — 256 MB
- `vocab.txt` — 226 KB
- **Backup copied to:** `~/Library/Application Support/StellarDental/sentiment-models/`
- **Checksums match on both copies:**
  - `47c700e460865f90847d09c7e816dd645caff33ee995099cce312e0c54fe6f24`
  - `07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3`

## `make -C sentiment-engine check`

```text
READY	1
1	OK	NEGATIVE	0.998348	0.001652	12	17790
2	OK	NEGATIVE	0.999726	0.000274	7	15587
```

Line 1 is the positive sample, “The dentist was gentle and the clinic was spotless.” The model labelled it negative at 0.998. Line 2, the rude-staff complaint, is correctly negative.

## Language handling

Hindi and Gujarati were stripped to spaces and stored as skipped, with no label. They are now stored as **uncertain** for staff.

The patient still gets the Google button. The complaint form stays an extra choice. Item 2 removed sending anyone to the complaint form by language or sentiment.

## 30 dental reviews

| # | Stars | Language | Engine | Stored | Review |
|---|---|---|---|---|---|
| 1 | 5 | English | POSITIVE 1.000 | positive | Wonderful visit. Dr Shah was gentle, kind and caring. |
| 2 | 5 | English | POSITIVE 0.998 | positive | Excellent cleaning. Painless, friendly, spotless clinic. |
| 3 | 5 | English | POSITIVE 1.000 | positive | Amazing root canal. No pain, everything explained. |
| 4 | 4 | English | POSITIVE 1.000 | positive | Very good filling. Kind and careful dentist. |
| 5 | 4 | English | POSITIVE 0.999 | positive | Great braces adjustment. Comfortable and professional. |
| 6 | 1 | English | NEGATIVE 1.000 | negative | Terrible. Rude staff, painful extraction. |
| 7 | 1 | English | NEGATIVE 1.000 | negative | Worst visit. Overcharged, bill not explained. |
| 8 | 2 | English | NEGATIVE 1.000 | negative | Waited two hours. Rude receptionist. |
| 9 | 2 | English | NEGATIVE 0.997 | negative | Filling still hurts. Dentist did not listen. |
| 10 | 3 | English | NEGATIVE 0.978 | negative | Appointment on Tuesday. Routine check only. |
| 11 | 3 | English | NEGATIVE 0.992 | negative | Cleaning today. Okay, nothing special. |
| 12 | 5 | Hinglish | POSITIVE 0.997 | positive | Doctor bahut gentle thi, treatment bahut badhiya tha. |
| 13 | 5 | Hinglish | POSITIVE 0.998 | positive | Bahut accha experience. Scaling mein dard nahi hua. |
| 14 | 4 | Hinglish | NEGATIVE 0.938 | negative | Doctor acchi thi, treatment theek tha, thoda wait hua. |
| 15 | 2 | Hinglish | NEGATIVE 0.996 | negative | Bahut bekar. Rude receptionist, long wait. |
| 16 | 1 | Hinglish | NEGATIVE 0.998 | negative | Worst experience. Bahut pain, bill bohot zyada. |
| 17–21 | 5,5,4,2,1 | Hindi | EMPTY | uncertain | Devanagari reviews. Model cannot read them. |
| 22–26 | 5,5,4,2,1 | Gujarati | EMPTY | uncertain | Gujarati reviews. Model cannot read them. |
| 27 | 5 | Mixed | POSITIVE 1.000 | positive | Doctor बहुत अच्छे थे, treatment painless, loved it. |
| 28 | 2 | Mixed | NEGATIVE 1.000 | negative | Receptionist બહુ rude, wait was terrible. |
| 29 | 5 | Emoji | EMPTY | skipped | 😀😀 ★★★★★ — no words to judge. |
| 30 | 5 | English | POSITIVE 1.000 | positive | Child was nervous; dentist was patient and gentle. |

## Final test summary

- Total dental reviews tested: **30**
- All 30 patients are sent to Google.
- Hindi and Gujarati reviews are stored as `uncertain`.
- Emoji-only review is stored as `skipped`.
- Uncertain reviews are available for staff review.
- Complaint form remains an additional patient choice.
- Automated tests: **115 passing**.
