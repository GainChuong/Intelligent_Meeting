/**
 * Toss-up Overlap & Recommendation Engine
 * Supports:
 * 1. Single-Group Day & Slot Overlap (Reproducing the exact Toss-up segmented bar + best overlap card)
 * 2. Cross-Group Multi-Crew Overlap Reconciliation
 * 3. Manager Mode (Mandatory hard constraint + highest priority weighting + 1-click Manager confirm)
 */

export const ALL_TIME_SLOTS = [
  '00:00', '00:30', '01:00', '01:30', '02:00', '02:30', '03:00', '03:30',
  '04:00', '04:30', '05:00', '05:30', '06:00', '06:30', '07:00', '07:30',
  '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
  '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30',
  '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30',
  '20:00', '20:30', '21:00', '21:30', '22:00', '22:30', '23:00', '23:30'
];

export function addMinutesToSlot(slotStr, minutesToAdd = 30) {
  const [hh, mm] = slotStr.split(':').map(Number);
  const total = hh * 60 + mm + minutesToAdd;
  const nh = Math.floor(total / 60);
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

/**
 * Find contiguous blocks of slots and score them
 */
function findBestWindowForDay({ dayMeta, members, votesForGroupWeek, managerEmail, managerMode, minQuorum }) {
  const totalMembers = Math.max(members.length, 1);
  const normalizedMgr = (managerEmail || '').toLowerCase();

  // Map each slot -> which members are available
  const slotMap = new Map();
  for (const slot of ALL_TIME_SLOTS) {
    const freeMembers = [];
    let managerFree = false;

    for (const m of members) {
      const mEmail = m.user_email.toLowerCase();
      const vote = votesForGroupWeek.find(v => v.user_email.toLowerCase() === mEmail);
      const daySlots = (vote && vote.slots && Array.isArray(vote.slots[dayMeta.code])) ? vote.slots[dayMeta.code] : [];
      if (daySlots.includes(slot)) {
        freeMembers.push({ email: m.user_email, name: m.user_name, role: m.role, avatar_color: m.avatar_color });
        if (mEmail === normalizedMgr || m.role === 'manager') {
          managerFree = true;
        }
      }
    }

    slotMap.set(slot, {
      slot,
      count: freeMembers.length,
      freeMembers,
      managerFree
    });
  }

  // Build candidate contiguous windows of 3 slots (90 mins) or 2 slots (60 mins)
  const candidates = [];
  for (let i = 0; i < ALL_TIME_SLOTS.length; i++) {
    for (const len of [3, 4, 2]) {
      if (i + len > ALL_TIME_SLOTS.length) continue;
      const slice = ALL_TIME_SLOTS.slice(i, i + len);
      // Verify contiguous 30-min steps
      let contiguous = true;
      for (let k = 0; k < slice.length - 1; k++) {
        if (addMinutesToSlot(slice[k], 30) !== slice[k + 1]) {
          contiguous = false;
          break;
        }
      }
      if (!contiguous) continue;

      // Find members free across ALL slots in this window
      const firstInfo = slotMap.get(slice[0]);
      const commonMembers = firstInfo.freeMembers.filter(m =>
        slice.every(s => slotMap.get(s).freeMembers.some(fm => fm.email.toLowerCase() === m.email.toLowerCase()))
      );
      const managerFreeAll = commonMembers.some(
        m => m.email.toLowerCase() === normalizedMgr || m.role === 'manager'
      );

      if (commonMembers.length === 0) continue;

      // If Manager Mode is ON, filter out windows where Manager is not free
      if (managerMode && !managerFreeAll) {
        continue;
      }

      const startTime = slice[0];
      const endTime = addMinutesToSlot(slice[slice.length - 1], 30);
      const ratio = commonMembers.length / totalMembers;
      // Score: prioritize member count, manager presence (+100 weight in manager mode, +15 default), and 90-min length
      const score =
        commonMembers.length * 100 +
        (managerFreeAll ? (managerMode ? 500 : 25) : 0) +
        (len === 4 ? 18 : len === 3 ? 15 : 8);

      candidates.push({
        dayCode: dayMeta.code,
        dayLabelVi: dayMeta.labelVi,
        dayNum: dayMeta.dayNum,
        dateIso: dayMeta.dateIso,
        startTime,
        endTime,
        timeRange: `${startTime}–${endTime}`,
        slots: slice,
        freeCount: commonMembers.length,
        totalMembers,
        ratio,
        hitsQuorum: commonMembers.length >= minQuorum,
        isFullOverlap: commonMembers.length === totalMembers,
        managerFree: managerFreeAll,
        freeMembers: commonMembers,
        missingMembers: members.filter(
          m => !commonMembers.some(cm => cm.email.toLowerCase() === m.user_email.toLowerCase())
        ),
        score
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0] || {
    dayCode: dayMeta.code,
    dayLabelVi: dayMeta.labelVi,
    dayNum: dayMeta.dayNum,
    dateIso: dayMeta.dateIso,
    startTime: '—',
    endTime: '—',
    timeRange: managerMode ? 'Manager bận / Chưa khớp' : 'Chưa có lịch trùng',
    slots: [],
    freeCount: 0,
    totalMembers,
    ratio: 0,
    hitsQuorum: false,
    isFullOverlap: false,
    managerFree: false,
    freeMembers: [],
    missingMembers: members,
    score: 0
  };

  return {
    bestWindow: best,
    topWindows: candidates.slice(0, 3),
    slotBreakdown: Array.from(slotMap.values())
  };
}

/**
 * Compute full overlap report for a single group in a given week
 */
export function computeGroupOverlap({ group, members, votes, weekMeta, managerModeOverride }) {
  const managerMode = typeof managerModeOverride === 'boolean' ? managerModeOverride : !!group.manager_mode_default;
  const votesForGroupWeek = votes.filter(
    v => v.group_id === group.id && v.week_key === weekMeta.weekKey
  );

  const dayReports = weekMeta.days.map(dayMeta =>
    findBestWindowForDay({
      dayMeta,
      members,
      votesForGroupWeek,
      managerEmail: group.manager_email,
      managerMode,
      minQuorum: group.min_quorum || 3
    })
  );

  // Determine the #1 overall best day card to mark "best overlap"
  let bestDayCode = null;
  let highestScore = 0;
  for (const dr of dayReports) {
    if (dr.bestWindow.score > highestScore && dr.bestWindow.freeCount > 0) {
      highestScore = dr.bestWindow.score;
      bestDayCode = dr.bestWindow.dayCode;
    }
  }

  const tossupCards = dayReports.map(dr => {
    const bw = dr.bestWindow;
    const isBestOverlap = bw.dayCode === bestDayCode && bw.freeCount > 0;
    return {
      ...bw,
      isBestOverlap,
      statusTone: bw.isFullOverlap || (bw.hitsQuorum && isBestOverlap) ? 'sage' : bw.freeCount > 0 ? 'coral' : 'muted',
      slotBreakdown: dr.slotBreakdown
    };
  });

  // Top 5 recommended windows across the whole week
  const allWindows = dayReports
    .flatMap(dr => dr.topWindows)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    groupId: group.id,
    groupName: group.name,
    weekKey: weekMeta.weekKey,
    rangeLabel: weekMeta.rangeLabel,
    managerEmail: group.manager_email,
    managerMode,
    minQuorum: group.min_quorum,
    totalMembers: members.length,
    votedMembersCount: votesForGroupWeek.length,
    bestRecommendation: allWindows[0] || null,
    recommendations: allWindows,
    tossupCards
  };
}

/**
 * Compute Cross-Group Overlap across multiple selected groups
 * Finds time windows where people across multiple groups (or shared members + manager) can meet,
 * or identifies cross-group scheduling conflicts.
 */
export function computeMultiGroupOverlap({ groups, allMembers, allVotes, weekMeta, managerMode = false, managerEmail = 'gameyuno123@gmail.com' }) {
  if (!groups || groups.length === 0) return { days: [], topSlots: [] };

  // Collect unique participants across all selected groups
  const participantMap = new Map();
  for (const grp of groups) {
    const gMembers = allMembers.filter(m => m.group_id === grp.id);
    for (const gm of gMembers) {
      const key = gm.user_email.toLowerCase();
      if (!participantMap.has(key)) {
        participantMap.set(key, {
          user_email: gm.user_email,
          user_name: gm.user_name,
          role: gm.role,
          avatar_color: gm.avatar_color,
          groups: [grp.name]
        });
      } else {
        participantMap.get(key).groups.push(grp.name);
      }
    }
  }

  const uniqueParticipants = Array.from(participantMap.values());
  const normalizedMgr = (managerEmail || '').toLowerCase();

  // Merge each participant's availability across the selected groups for this week
  const mergedVotes = uniqueParticipants.map(p => {
    const pVotes = allVotes.filter(
      v =>
        v.week_key === weekMeta.weekKey &&
        v.user_email.toLowerCase() === p.user_email.toLowerCase() &&
        groups.some(g => g.id === v.group_id)
    );
    const mergedSlots = {};
    for (const day of weekMeta.days) {
      const slotSet = new Set();
      for (const pv of pVotes) {
        const arr = pv.slots?.[day.code] || [];
        arr.forEach(s => slotSet.add(s));
      }
      mergedSlots[day.code] = Array.from(slotSet);
    }
    return {
      group_id: 'multi',
      week_key: weekMeta.weekKey,
      user_email: p.user_email,
      user_name: p.user_name,
      slots: mergedSlots
    };
  });

  const daySummaries = weekMeta.days.map(dayMeta => {
    const res = findBestWindowForDay({
      dayMeta,
      members: uniqueParticipants,
      votesForGroupWeek: mergedVotes,
      managerEmail: normalizedMgr,
      managerMode,
      minQuorum: Math.max(2, Math.ceil(uniqueParticipants.length * 0.75))
    });

    // Also compute per-group readiness on this day
    const perGroupBest = groups.map(g => {
      const gMembers = allMembers.filter(m => m.group_id === g.id);
      const gVotes = allVotes.filter(v => v.group_id === g.id && v.week_key === weekMeta.weekKey);
      const gDay = findBestWindowForDay({
        dayMeta,
        members: gMembers,
        votesForGroupWeek: gVotes,
        managerEmail: g.manager_email,
        managerMode,
        minQuorum: g.min_quorum || 3
      });
      return {
        groupId: g.id,
        groupName: g.name,
        timeRange: gDay.bestWindow.timeRange,
        freeCount: gDay.bestWindow.freeCount,
        totalMembers: gDay.bestWindow.totalMembers,
        managerFree: gDay.bestWindow.managerFree
      };
    });

    return {
      ...res.bestWindow,
      perGroupBest
    };
  });

  const bestMultiSlot = [...daySummaries]
    .filter(d => d.freeCount > 0)
    .sort((a, b) => b.score - a.score)[0] || null;

  return {
    weekKey: weekMeta.weekKey,
    rangeLabel: weekMeta.rangeLabel,
    selectedGroups: groups.map(g => ({ id: g.id, name: g.name })),
    totalUniqueParticipants: uniqueParticipants.length,
    participants: uniqueParticipants,
    managerMode,
    bestMultiSlot,
    days: daySummaries
  };
}

