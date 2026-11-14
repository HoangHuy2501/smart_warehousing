'use strict';

// Trừ một tháng lịch theo UTC, giới hạn ngày theo tháng đích.
function previousMonthCutoff(now = new Date()) {
    const cutoff = new Date(now);
    const day = cutoff.getUTCDate();
    cutoff.setUTCDate(1);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
    const endOfMonth = new Date(cutoff);
    endOfMonth.setUTCMonth(endOfMonth.getUTCMonth() + 1, 0);
    cutoff.setUTCDate(Math.min(day, endOfMonth.getUTCDate()));
    return cutoff;
}

module.exports = { previousMonthCutoff };
