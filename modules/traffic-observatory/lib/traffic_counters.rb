# frozen_string_literal: true

require 'date'
require 'time'

def parse_time(value)
  Time.strptime(value.to_s, '%Y-%m-%dT%H:%M:%S%z')
rescue ArgumentError
  nil
end

def delta(current, base)
  current = current.to_i
  base = base.to_i
  current >= base ? current - base : current
end

def period_range(arg, now = Time.now)
  today = Date.today
  case arg
  when '', 'today', 'current', 'current-day'
    start_date = today
    label = 'today'
    days = 1
  when 'yesterday'
    start_date = today - 1
    label = 'yesterday'
    days = 1
  when 'week'
    start_date = today - 6
    label = 'last 7 days'
    days = 7
  when 'month'
    start_date = today - 29
    label = 'last 30 days'
    days = 30
  when /\A\d{4}-\d{2}-\d{2}\z/
    start_date = Date.iso8601(arg)
    label = arg
    days = 1
  else
    warn "Unknown period '#{arg}', falling back to today"
    start_date = today
    label = 'today'
    days = 1
  end

  start_time = Time.new(start_date.year, start_date.month, start_date.day, 0, 0, 0, now.utc_offset)
  end_date = start_date + days
  end_time = Time.new(end_date.year, end_date.month, end_date.day, 0, 0, 0, now.utc_offset)
  [label, start_time, end_time]
end

def rows_in_period(path, start_time, end_time, include_end: false)
  rows = []
  return rows unless File.exist?(path)

  File.foreach(path) do |line|
    parts = line.strip.split('|', -1)
    next if parts.empty?
    ts = parse_time(parts[0])
    next unless ts
    next if ts < start_time
    next if include_end ? ts > end_time : ts >= end_time

    rows << [ts, parts]
  end
  rows
end

def counter_delta(rows, key_index, value_indexes, single_row_as_current: false)
  by_key = Hash.new { |hash, key| hash[key] = [] }
  rows.each do |ts, parts|
    key = parts[key_index]
    next if key.nil? || key.empty?

    by_key[key] << [ts, parts]
  end

  result = {}
  by_key.each do |key, key_rows|
    sorted = key_rows.sort_by(&:first)
    first = sorted.first[1]
    last = sorted.last[1]
    values =
      if single_row_as_current && sorted.length == 1
        value_indexes.map { |idx| last[idx].to_i }
      else
        value_indexes.map { |idx| delta(last[idx], first[idx]) }
      end
    result[key] = {
      first_ts: sorted.first[0],
      last_ts: sorted.last[0],
      first: first,
      last: last,
      values: values
    }
  end
  result
end

def window_for(rows)
  return 'n/a (no samples in period)' if rows.empty?

  sorted = rows.sort_by(&:first)
  "#{sorted.first[0].strftime('%Y-%m-%dT%H:%M:%S%z')} -> #{sorted.last[0].strftime('%Y-%m-%dT%H:%M:%S%z')}"
end

def load_device_metadata_map(path)
  metadata = {}
  return metadata if path.nil? || path.empty? || !File.exist?(path)

  File.foreach(path) do |line|
    next if line.strip.empty? || line.lstrip.start_with?('#')

    key, label = line.chomp.split('|', -1).map { |part| part.to_s.strip }
    next if key.nil? || key.empty?
    next if label.nil? || label.empty?

    metadata[key] = label
  end
  metadata
end
