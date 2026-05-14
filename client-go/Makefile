# Cross-platform build matrix for agent-client.
# Usage:
#   make            # native build
#   make all        # full matrix into ./dist
#   make tidy       # go mod tidy
#   make clean

BINARY := agent-client
DIST   := dist
LDFLAGS := -s -w

.PHONY: all native tidy clean

native:
	go build -ldflags "$(LDFLAGS)" -o $(BINARY) .

tidy:
	go mod tidy

clean:
	rm -rf $(DIST) $(BINARY) $(BINARY).exe

all: $(DIST)/$(BINARY)-windows-amd64.exe \
     $(DIST)/$(BINARY)-windows-arm64.exe \
     $(DIST)/$(BINARY)-macos-amd64 \
     $(DIST)/$(BINARY)-macos-arm64 \
     $(DIST)/$(BINARY)-linux-amd64 \
     $(DIST)/$(BINARY)-linux-arm64

$(DIST)/$(BINARY)-windows-amd64.exe:
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $@ .

$(DIST)/$(BINARY)-windows-arm64.exe:
	GOOS=windows GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $@ .

$(DIST)/$(BINARY)-macos-amd64:
	GOOS=darwin GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $@ .

$(DIST)/$(BINARY)-macos-arm64:
	GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $@ .

$(DIST)/$(BINARY)-linux-amd64:
	GOOS=linux GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $@ .

$(DIST)/$(BINARY)-linux-arm64:
	GOOS=linux GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $@ .
