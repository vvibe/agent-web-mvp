package main

import (
	"fmt"
	"runtime"
)

func runtimeLabel() string {
	return fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH)
}
