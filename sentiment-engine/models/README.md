# Model files

The engine needs two files here (not committed — the model is ~255 MB):

| File                   | Purpose                                     |
| ---------------------- | ------------------------------------------- |
| `distilbert-sst2.onnx` | DistilBERT fine-tuned on SST-2 (ONNX)       |
| `vocab.txt`            | Matching WordPiece vocabulary (30,522 rows) |

These are the same files the supplied `UpdatedUltra-low-latency.cpp` was written against. Copy or symlink them in:

```bash
ln -s /path/to/python-testing-folder/distilbert-sst2.onnx sentiment-engine/models/
ln -s /path/to/python-testing-folder/vocab.txt sentiment-engine/models/
```

Or point `SENTIMENT_MODEL_PATH` / `SENTIMENT_VOCAB_PATH` at them directly. Verify with `make -C sentiment-engine check`.
