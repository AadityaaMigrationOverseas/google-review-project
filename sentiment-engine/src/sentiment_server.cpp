// Persistent, non-interactive front end for the supplied sentiment engine.
//
// The supplied source (vendor/UpdatedUltra-low-latency.cpp) is compiled
// unmodified: its tokenizer, ONNX session setup and analyze_review_onnx()
// are reused as-is. Only its interactive terminal main() is renamed so this
// file can expose a line-oriented stdin/stdout protocol instead.
//
// Protocol (one request / response per line, UTF-8, tab separated):
//   startup  -> "READY\t<protocol>"                 (stdout, after model load)
//   request  <- "<id>\t<text>"                      (id = 1..16 decimal digits)
//   success  -> "<id>\tOK\t<LABEL>\t<confidence>\t<p_positive>\t<tokens>\t<micros>"
//   failure  -> "<id>\tERR\t<code>"
// Fatal start-up errors are written to stderr and the process exits with 2.

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <termios.h>
#include <thread>
#include <unistd.h>
#include <unordered_map>
#include <vector>
#include <onnxruntime_cxx_api.h>

#define main stellar_interactive_main
#include "../vendor/UpdatedUltra-low-latency.cpp"
#undef main

namespace {

constexpr const char* kProtocolVersion = "1";
constexpr std::size_t kMaxLineBytes = 16 * 1024;
constexpr std::size_t kMaxIdDigits = 16;
// DistilBERT position embeddings are limited to 512 tokens (incl. CLS/SEP).
constexpr std::size_t kMaxTokens = 512;

// The supplied tokenizer calls std::isalnum on plain `char`, which is
// undefined for negative values (non-ASCII UTF-8 bytes). Mapping those bytes
// and control characters to spaces keeps its behaviour defined; the uncased
// English vocabulary would discard them anyway.
std::string sanitize(const std::string& raw) {
    std::string out;
    out.reserve(raw.size());
    for (unsigned char c : raw) {
        out.push_back((c < 0x20 || c >= 0x7f) ? ' ' : static_cast<char>(c));
    }
    return out;
}

bool has_alnum(const std::string& s) {
    return std::any_of(s.begin(), s.end(),
                       [](unsigned char c) { return std::isalnum(c) != 0; });
}

// Drops trailing words until the token sequence fits the model's window.
std::string fit_to_token_limit(const std::string& text, std::size_t& token_count) {
    token_count = tokenizer.tokenize(text).size();
    if (token_count <= kMaxTokens) return text;

    std::vector<std::string> words;
    std::stringstream ss(text);
    std::string w;
    while (ss >> w) words.push_back(w);

    std::size_t keep = words.size() * kMaxTokens / token_count;
    while (keep > 0) {
        std::string candidate;
        for (std::size_t i = 0; i < keep; ++i) {
            if (i) candidate.push_back(' ');
            candidate += words[i];
        }
        token_count = tokenizer.tokenize(candidate).size();
        if (token_count <= kMaxTokens) return candidate;
        --keep;
    }
    token_count = 2;
    return "";
}

void reply_error(const std::string& id, const char* code) {
    std::cout << id << '\t' << "ERR" << '\t' << code << '\n' << std::flush;
}

bool parse_args(int argc, char** argv, std::string& model, std::string& vocab) {
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if ((arg == "--model" || arg == "--vocab") && i + 1 < argc) {
            (arg == "--model" ? model : vocab) = argv[++i];
        } else {
            return false;
        }
    }
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    std::ios::sync_with_stdio(false);

    std::string model_path = "distilbert-sst2.onnx";
    std::string vocab_path = "vocab.txt";
    if (!parse_args(argc, argv, model_path, vocab_path)) {
        std::cerr << "FATAL\tusage: sentiment_server [--model PATH] [--vocab PATH]\n";
        return 2;
    }

    try {
        initialize_engine(model_path, vocab_path);
        analyze_review_onnx("warm up the inference session");
    } catch (const std::exception& e) {
        std::cerr << "FATAL\t" << e.what() << '\n';
        return 2;
    }

    std::cout << "READY\t" << kProtocolVersion << '\n' << std::flush;

    std::string line;
    while (std::getline(std::cin, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;

        const std::size_t tab = line.find('\t');
        if (tab == std::string::npos || tab == 0 || tab > kMaxIdDigits) {
            reply_error("0", "MALFORMED");
            continue;
        }
        const std::string id = line.substr(0, tab);
        if (!std::all_of(id.begin(), id.end(),
                         [](unsigned char c) { return std::isdigit(c) != 0; })) {
            reply_error("0", "MALFORMED");
            continue;
        }
        if (line.size() > kMaxLineBytes) {
            reply_error(id, "TOO_LONG");
            continue;
        }

        const std::string text = sanitize(line.substr(tab + 1));
        if (!has_alnum(text)) {
            reply_error(id, "EMPTY");
            continue;
        }

        try {
            const auto started = std::chrono::steady_clock::now();
            std::size_t tokens = 0;
            const std::string fitted = fit_to_token_limit(text, tokens);
            const SentimentResult r = analyze_review_onnx(fitted);
            const auto micros = std::chrono::duration_cast<std::chrono::microseconds>(
                                    std::chrono::steady_clock::now() - started)
                                    .count();
            const float p_positive = r.flag == 1 ? r.confidence : 1.0f - r.confidence;
            if (!std::isfinite(r.confidence)) {
                reply_error(id, "NUMERIC");
                continue;
            }
            std::cout << id << "\tOK\t" << r.label << '\t' << std::fixed
                      << std::setprecision(6) << r.confidence << '\t' << p_positive
                      << '\t' << tokens << '\t' << micros << '\n'
                      << std::flush;
        } catch (const std::exception& e) {
            std::cerr << "inference error for request " << id << ": " << e.what() << '\n';
            reply_error(id, "INFERENCE");
        }
    }
    return 0;
}
