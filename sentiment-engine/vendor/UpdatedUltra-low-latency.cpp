#include <iostream>
#include <vector>
#include <string>
#include <unordered_map>
#include <fstream>
#include <sstream>
#include <algorithm>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <cmath>
#include <iomanip>
#include <termios.h>
#include <unistd.h>
#include <onnxruntime_cxx_api.h>

// ==========================================
// 1. BUILT-IN WORDPIECE TOKENIZER
// ==========================================
class WordPieceTokenizer {
private:
    std::unordered_map<std::string, int64_t> vocab;
    int64_t unk_token_id = 100;
    int64_t cls_token_id = 101;
    int64_t sep_token_id = 102;

public:
    bool load_vocab(const std::string& vocab_path) {
        std::ifstream file(vocab_path);
        if (!file.is_open()) return false;
        
        std::string line;
        int64_t index = 0;
        while (std::getline(file, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            vocab[line] = index++;
        }
        return true;
    }

    std::vector<int64_t> tokenize(const std::string& text) {
        std::vector<int64_t> token_ids;
        token_ids.push_back(cls_token_id);

        std::string cleaned;
        for (char c : text) {
            if (std::isalnum(c) || std::isspace(c)) {
                cleaned += std::tolower(c);
            }
        }

        std::stringstream ss(cleaned);
        std::string word;
        while (ss >> word) {
            int start = 0;
            int n = word.length();
            while (start < n) {
                int end = n;
                std::string cur_substr = "";
                bool found = false;

                while (start < end) {
                    std::string sub = word.substr(start, end - start);
                    if (start > 0) sub = "##" + sub;
                    if (vocab.find(sub) != vocab.end()) {
                        cur_substr = sub;
                        found = true;
                        break;
                    }
                    end--;
                }

                if (!found) {
                    token_ids.push_back(unk_token_id);
                    break;
                } else {
                    token_ids.push_back(vocab[cur_substr]);
                    start = end;
                }
            }
        }
        token_ids.push_back(sep_token_id);
        return token_ids;
    }
};

// ==========================================
// 2. ONNX INFERENCE ENGINE & DATA STRUCTS
// ==========================================
struct SentimentResult {
    std::string text;
    std::string label;
    float confidence;
    int flag;
    std::string redirect_target;
};

WordPieceTokenizer tokenizer;
Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "SentimentAnalysis");
Ort::SessionOptions session_options;
std::unique_ptr<Ort::Session> session;

std::string current_text = "";
SentimentResult latest_result;
std::atomic<bool> is_typing(true);
bool text_changed = false;
std::mutex mtx;
std::condition_variable cv;

void initialize_engine(const std::string& model_path, const std::string& vocab_path) {
    if (!tokenizer.load_vocab(vocab_path)) {
        throw std::runtime_error("Could not load vocab.txt from: " + vocab_path);
    }
    session_options.SetIntraOpNumThreads(1);
    session_options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_EXTENDED);
    session = std::make_unique<Ort::Session>(env, model_path.c_str(), session_options);
}

SentimentResult analyze_review_onnx(const std::string& text) {
    SentimentResult res;
    res.text = text;

    std::vector<int64_t> input_ids = tokenizer.tokenize(text);
    std::vector<int64_t> attention_mask(input_ids.size(), 1);
    std::vector<int64_t> input_shape = {1, static_cast<int64_t>(input_ids.size())};

    Ort::MemoryInfo memory_info = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

    Ort::Value input_tensor = Ort::Value::CreateTensor<int64_t>(
        memory_info, input_ids.data(), input_ids.size(), input_shape.data(), input_shape.size());

    Ort::Value mask_tensor = Ort::Value::CreateTensor<int64_t>(
        memory_info, attention_mask.data(), attention_mask.size(), input_shape.data(), input_shape.size());

    const char* input_names[] = {"input_ids", "attention_mask"};
    const char* output_names[] = {"logits"};
    std::vector<Ort::Value> inputs;
    inputs.push_back(std::move(input_tensor));
    inputs.push_back(std::move(mask_tensor));

    auto output_tensors = session->Run(Ort::RunOptions{nullptr}, input_names, inputs.data(), 2, output_names, 1);

    float* floatarr = output_tensors.front().GetTensorMutableData<float>();
    
    // Softmax calculation
    float exp_neg = std::exp(floatarr[0]);
    float exp_pos = std::exp(floatarr[1]);
    float sum_exp = exp_neg + exp_pos;
    float prob_neg = exp_neg / sum_exp;
    float prob_pos = exp_pos / sum_exp;

    if (prob_pos > prob_neg) {
        res.label = "POSITIVE";
        res.confidence = prob_pos;
        res.flag = 1;
        res.redirect_target = "/reviews/thank-you";
    } else {
        res.label = "NEGATIVE";
        res.confidence = prob_neg;
        res.flag = 0;
        res.redirect_target = "/support/complaint-box";
    }

    return res;
}

// ==========================================
// 3. TERMINAL UI & THREAD PIPELINE
// ==========================================
char getch() {
    char buf = 0;
    struct termios old = {0};
    if (tcgetattr(0, &old) < 0) perror("tcsetattr()");
    old.c_lflag &= ~ICANON;
    old.c_lflag &= ~ECHO;
    old.c_cc[VMIN] = 1;
    old.c_cc[VTIME] = 0;
    if (tcsetattr(0, TCSANOW, &old) < 0) perror("tcsetattr ICANON");
    if (read(0, &buf, 1) < 0) perror("read()");
    old.c_lflag |= ICANON;
    old.c_lflag |= ECHO;
    if (tcsetattr(0, TCSADRAIN, &old) < 0) perror("tcsetattr ~ICANON");
    return buf;
}

void update_display() {
    std::lock_guard<std::mutex> lock(mtx);
    std::cout << "\033[2J\033[H";
    std::cout << "============================================================\n";
    std::cout << " C++ ONNX LIVE SENTIMENT (Type review, press ENTER to finish)\n";
    std::cout << "============================================================\n\n";
    std::cout << "Input: " << current_text << "\n\n";
    
    if (!current_text.empty() && !latest_result.label.empty()) {
        std::cout << "  -> Live Prediction: " << latest_result.label 
                  << " (Confidence: " << std::fixed << std::setprecision(4) << latest_result.confidence << ")\n";
        std::cout << "  -> Redirect To:     " << latest_result.redirect_target << "\n";
    } else {
        std::cout << "  -> Live Prediction: Waiting for input...\n";
    }
    std::cout << std::flush;
}

void background_analyzer() {
    std::string text_to_analyze = "";
    while (is_typing) {
        std::unique_lock<std::mutex> lock(mtx);
        cv.wait(lock, []{ return text_changed || !is_typing; });
        
        if (!is_typing) break;
        
        text_to_analyze = current_text;
        text_changed = false;
        lock.unlock();

        if (!text_to_analyze.empty()) {
            SentimentResult res = analyze_review_onnx(text_to_analyze);
            
            lock.lock();
            latest_result = res;
            lock.unlock();
            
            update_display();
        }
    }
}

int main() {
    try {
        initialize_engine("distilbert-sst2.onnx", "vocab.txt");
    } catch (const std::exception& e) {
        std::cerr << "Initialization error: " << e.what() << "\n";
        return 1;
    }

    std::thread analyzer_thread(background_analyzer);
    update_display();

    while (is_typing) {
        char c = getch();
        {
            std::lock_guard<std::mutex> lock(mtx);
            if (c == '\n' || c == '\r') {
                is_typing = false;
                cv.notify_one();
                break;
            } else if (c == 127 || c == 8) {
                if (!current_text.empty()) {
                    current_text.pop_back();
                    text_changed = true;
                }
            } else if (c == 3 || c == 27) {
                current_text = "";
                is_typing = false;
                cv.notify_one();
                break;
            } else {
                current_text += c;
                text_changed = true;
            }
        }
        cv.notify_one();
        update_display();
    }

    analyzer_thread.join();

    std::cout << "\033[2J\033[H";
    std::cout << "============================================================\n";
    std::cout << " FINAL RESULT\n";
    std::cout << "============================================================\n";
    std::cout << "\nReview: '" << current_text << "'\n";
    if (!current_text.empty()) {
        std::cout << "  -> Prediction:  " << latest_result.label 
                  << " (Confidence: " << std::fixed << std::setprecision(4) << latest_result.confidence << ")\n";
        std::cout << "  -> Binary Flag: " << latest_result.flag << "\n";
        std::cout << "  -> Redirect To: " << latest_result.redirect_target << "\n\n";
    }
    return 0;
}