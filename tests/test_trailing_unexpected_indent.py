# COMMAND LINE:
# grun Python file_input -tokens test_trailing_unexpected_indent.py
#
# EXPECTATION:
#   - no error

if True:
    j = 0  # the last line (next line) is an unexpected indent
      