'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const activityKeys = {
  day: (p) => ['activity', 'day', p],
  week: (p) => ['activity', 'week', p],
  team: (p) => ['activity', 'team', p],
  trends: (p) => ['activity', 'trends', p],
  reports: ['reports', 'catalog'],
  report: (type, p) => ['reports', 'run', type, p],
  jobs: ['reports', 'jobs'],
};

const get = (path, query) => async () => (await api.get(path, { query })).data;

export const useActivityDay = (params) => useQuery({ queryKey: activityKeys.day(params), queryFn: get('/activity/day', params) });
export const useActivityWeek = (params) => useQuery({ queryKey: activityKeys.week(params), queryFn: get('/activity/week', params) });
export const useTeamDay = (params, enabled = true) => useQuery({ queryKey: activityKeys.team(params), queryFn: get('/activity/team', params), enabled });
export const useTrends = (params) => useQuery({ queryKey: activityKeys.trends(params), queryFn: get('/activity/trends', params) });
