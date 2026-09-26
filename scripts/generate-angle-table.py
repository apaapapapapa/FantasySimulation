"""Reproducible decimal Taylor series, round-half-even to 1e-9, no runtime trig."""
from decimal import Decimal, localcontext, ROUND_HALF_EVEN
from pathlib import Path

with localcontext() as ctx:
    ctx.prec = 80
    pi = Decimal('3.14159265358979323846264338327950288419716939937510582097494459230781640628620899')
    values = []
    for degree in range(91):
        x = Decimal(degree) * pi / 180
        term = x
        total = x
        for n in range(1, 80):
            term *= -x * x / (2 * n * (2 * n + 1))
            total += term
        values.append(int((total * 1_000_000_000).to_integral_value(rounding=ROUND_HALF_EVEN)))
    output = Path(__file__).resolve().parents[1] / 'packages/domain/src/spatial/sine-table.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    # Match the pinned formatter's 100-column numeric-array representation, including LF on Windows.
    lines = ['[']
    line = ' '
    for index, value in enumerate(values):
        token = str(value) + (',' if index < len(values) - 1 else '')
        if len(line) + 1 + len(token) > 100:
            lines.append(line)
            line = ' '
        line += ' ' + token
    lines.extend([line, ']'])
    output.write_bytes(('\n'.join(lines) + '\n').encode('utf-8'))
