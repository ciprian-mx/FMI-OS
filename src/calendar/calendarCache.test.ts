import {
  calendarCacheKey,
  calendarCachePrefix,
  CachedCalendarEvents,
  createMemoryEventCache,
} from './calendarCache';

/**
 * Task 7.1 — the event cache the Calendar App renders from, so pulled events
 * persist independently of the current pull's status.
 *
 * Validates: Requirement 10.1
 */

const ENTRY: CachedCalendarEvents = { events: [], fetchedAt: 1 };

describe('createMemoryEventCache', () => {
  it('stores entries, notifies subscribers and clears one provider at a time', () => {
    const cache = createMemoryEventCache();
    const listener = jest.fn();
    const unsubscribe = cache.subscribe(listener);
    const googleKey = calendarCacheKey('google', { start: 0, end: 7 });
    const outlookKey = calendarCacheKey('outlook', { start: 0, end: 7 });

    cache.write(googleKey, ENTRY);
    cache.write(outlookKey, ENTRY);
    expect(cache.read(googleKey)).toBe(ENTRY);
    expect(listener).toHaveBeenCalledTimes(2);

    cache.clear(calendarCachePrefix('google'));
    expect(cache.read(googleKey)).toBeUndefined();
    expect(cache.read(outlookKey)).toBe(ENTRY);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    cache.clear();
    expect(cache.read(outlookKey)).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('evicts the least recently written entries beyond its limit', () => {
    const cache = createMemoryEventCache(2);
    cache.write('a', ENTRY);
    cache.write('b', ENTRY);
    cache.write('a', ENTRY);
    cache.write('c', ENTRY);

    expect(cache.read('b')).toBeUndefined();
    expect(cache.read('a')).toBe(ENTRY);
    expect(cache.read('c')).toBe(ENTRY);
  });
});
