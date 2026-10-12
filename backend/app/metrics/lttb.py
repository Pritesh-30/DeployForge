"""
Largest-Triangle-Three-Buckets downsampling (Steinarsson, 2013).

A day of samples every 15 seconds is 5,760 points per series. A chart a few
hundred pixels wide cannot show them, and sending them all costs bandwidth
and browser time for nothing. Averaging them down is the obvious fix and the
wrong one: it flattens exactly the spikes someone opened the graph to find.

LTTB keeps the first and last points, splits the rest into buckets, and from
each bucket keeps the single point that forms the largest triangle with the
point kept before it and the average of the bucket after it. Visually
significant points — peaks, troughs, edges — survive; flat stretches collapse.
One pass, O(n).
"""

from __future__ import annotations

from collections.abc import Sequence

Point = tuple[float, float]


def lttb(points: Sequence[Point], threshold: int) -> list[Point]:
    """
    Downsample `points` (sorted by x) to at most `threshold` points.

    Returns the input unchanged when it is already small enough, or when the
    threshold is too small to keep both ends and something between them.
    """
    n = len(points)
    if threshold >= n or threshold < 3:
        return list(points)

    sampled: list[Point] = [points[0]]
    # Bucket width over the interior points; the ends are kept separately.
    every = (n - 2) / (threshold - 2)
    a = 0  # index of the point most recently kept

    for i in range(threshold - 2):
        # The average of the *next* bucket is the third corner of the triangle.
        next_start = int((i + 1) * every) + 1
        next_end = min(int((i + 2) * every) + 1, n)
        span = points[next_start:next_end] or [points[-1]]
        avg_x = sum(p[0] for p in span) / len(span)
        avg_y = sum(p[1] for p in span) / len(span)

        start = int(i * every) + 1
        end = int((i + 1) * every) + 1
        ax, ay = points[a]

        best_area = -1.0
        best = start
        for j in range(start, end):
            x, y = points[j]
            # Twice the triangle's area; the factor is irrelevant to the max.
            area = abs((ax - avg_x) * (y - ay) - (ax - x) * (avg_y - ay))
            if area > best_area:
                best_area = area
                best = j

        sampled.append(points[best])
        a = best

    sampled.append(points[-1])
    return sampled
