ORT_DIR ?= third_party/onnxruntime
CXX ?= c++
BUILD_DIR := build
TARGET := $(BUILD_DIR)/sentiment_server

ORT_LIB := $(abspath $(ORT_DIR)/lib)
CXXFLAGS ?= -O3 -DNDEBUG
CXXFLAGS += -std=c++17 -Wall -I$(ORT_DIR)/include
LDFLAGS += -L$(ORT_LIB) -lonnxruntime -Wl,-rpath,$(ORT_LIB)

.PHONY: all clean check

all: $(TARGET)

$(TARGET): src/sentiment_server.cpp vendor/UpdatedUltra-low-latency.cpp
	@test -f $(ORT_DIR)/include/onnxruntime_cxx_api.h || \
		(echo "ONNX Runtime not found in $(ORT_DIR). Run scripts/fetch-onnxruntime.sh" && exit 1)
	@mkdir -p $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) src/sentiment_server.cpp -o $@ $(LDFLAGS)

check: $(TARGET)
	@printf '1\tThe dentist was gentle and the clinic was spotless\n2\tTerrible wait and rude staff\n' | \
		$(TARGET) --model models/distilbert-sst2.onnx --vocab models/vocab.txt

clean:
	rm -rf $(BUILD_DIR)
