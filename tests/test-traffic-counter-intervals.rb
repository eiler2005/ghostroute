#!/usr/bin/env ruby
require_relative '../modules/traffic-observatory/lib/traffic_counters'

def check(values, expected, coverage)
  rows = values.each_with_index.map { |n, i| [Time.utc(2026, 1, 1, 0, i), ['', 'fixture', n.to_s]] }
  result = counter_delta(rows, 1, [2], single_row_as_current: true).fetch('fixture')
  raise "incorrect interval sum" unless result[:values] == [expected]
  raise "incorrect coverage" unless result[:coverage_status] == coverage
end

check([1000], 0, 'baseline_missing')
check([100, 150, 200], 100, 'observed_interval')
check([100, 150, 20, 70], 100, 'reset_gap')
check([100, 100, 100], 0, 'observed_interval')
check([100, 150, 150, 200], 100, 'observed_interval')
puts 'counter interval tests passed'
