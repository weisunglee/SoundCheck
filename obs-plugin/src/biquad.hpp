// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 weisunglee

#pragma once

#include <cmath>

/**
 * Second-order IIR section (transposed direct form II) with coefficients from Robert
 * Bristow-Johnson's Audio EQ Cookbook. The same formulas are in src-tauri/src/voice_analysis.rs,
 * which uses them to predict what the filter does.
 */
struct Biquad {
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    double z1 = 0, z2 = 0;

    float process(float in)
    {
        double x = in;
        double y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return float(y);
    }

    void reset() { z1 = z2 = 0; }

    static constexpr double kPi = 3.14159265358979323846;

    void set(double nb0, double nb1, double nb2, double a0, double na1, double na2)
    {
        b0 = nb0 / a0;
        b1 = nb1 / a0;
        b2 = nb2 / a0;
        a1 = na1 / a0;
        a2 = na2 / a0;
    }

    void highpass(double rate, double freq, double q)
    {
        double w = 2 * kPi * freq / rate, c = std::cos(w), alpha = std::sin(w) / (2 * q);
        set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
    }

    /** Band-pass with 0 dB gain at `freq`. */
    void bandpass(double rate, double freq, double q)
    {
        double w = 2 * kPi * freq / rate, c = std::cos(w), alpha = std::sin(w) / (2 * q);
        set(alpha, 0, -alpha, 1 + alpha, -2 * c, 1 - alpha);
    }

    void peak(double rate, double freq, double gain_db, double q)
    {
        double a = std::pow(10.0, gain_db / 40), w = 2 * kPi * freq / rate, c = std::cos(w);
        double alpha = std::sin(w) / (2 * q);
        set(1 + alpha * a, -2 * c, 1 - alpha * a, 1 + alpha / a, -2 * c, 1 - alpha / a);
    }

    /** High shelf with slope 1. */
    void high_shelf(double rate, double freq, double gain_db)
    {
        double a = std::pow(10.0, gain_db / 40), w = 2 * kPi * freq / rate, c = std::cos(w);
        double alpha = std::sin(w) / 2 * std::sqrt(2.0);
        double sa = 2 * std::sqrt(a) * alpha;
        set(a * ((a + 1) + (a - 1) * c + sa), -2 * a * ((a - 1) + (a + 1) * c), a * ((a + 1) + (a - 1) * c - sa),
            (a + 1) - (a - 1) * c + sa, 2 * ((a - 1) - (a + 1) * c), (a + 1) - (a - 1) * c - sa);
    }
};
