#!/usr/bin/env bash
# Terminal output throughput benchmark for the M1 go/no-go decision.
#
# Run the same command inside hbox-term and inside a reference terminal (Ghostty, iTerm2),
# in a window of the same size, and compare the MB/s lines:
#
#   bench/throughput.sh            # 64 MiB, 3 runs
#   bench/throughput.sh 256 5      # 256 MiB, 5 runs
#
# The time is how long the terminal takes to accept the output, so a slow renderer shows
# up as lower throughput (hbox-term's flow control slows `cat` instead of buffering).
set -euo pipefail

size_mib=${1:-64}
runs=${2:-3}
data=${TMPDIR:-/tmp}/hbox-term-bench-${size_mib}m.txt

if [[ ! -s $data ]]; then
  echo "Generating ${size_mib} MiB of test output in ${data}…"
  # A mix of plain text, SGR colour sequences and multi-byte UTF-8, like build and log output.
  python3 - "$data" "$size_mib" <<'PY'
import random, sys
path, size = sys.argv[1], int(sys.argv[2]) * 1024 * 1024
rng = random.Random(42)
words = ["build", "error", "warning", "compiling", "src/main.rs", "ok", "λ", "→", "✓", "数据", "0x7ffd", "INFO", "DEBUG"]
with open(path, "w", encoding="utf-8") as out:
    written = 0
    while written < size:
        parts = []
        for _ in range(rng.randint(4, 18)):
            word = rng.choice(words)
            if rng.random() < 0.25:
                word = f"\x1b[{rng.choice([31, 32, 33, 34, 35, 36, 90])}m{word}\x1b[0m"
            parts.append(word)
        line = " ".join(parts) + "\n"
        out.write(line)
        written += len(line.encode())
PY
fi

bytes=$(wc -c < "$data")
results=()
for run in $(seq 1 "$runs"); do
  start=$(date +%s.%N)
  cat "$data"
  end=$(date +%s.%N)
  results+=("$(python3 -c "print(f'{$bytes / ($end - $start) / 1048576:.1f}')")")
done

printf '\n\033[1mhbox-term throughput benchmark\033[0m\n'
printf 'terminal: %s   size: %s MiB   window: %sx%s\n' "${TERM_PROGRAM:-unknown}" "$size_mib" "$(tput cols)" "$(tput lines)"
for index in "${!results[@]}"; do printf '  run %d: %s MB/s\n' "$((index + 1))" "${results[$index]}"; done
