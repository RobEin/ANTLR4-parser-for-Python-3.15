# COMMAND LINE:
# grun Python file_input -tokens test_error_tab_and_space_in_indentation.py
#
# EXPECTATIONS:
#   - inserted ERROR_TOKEN instead of the WS token
#   - lexer error message: line 10:1 mismatched input ' ERROR: inconsistent use of tabs and spaces in indentation' expecting DEDENT

if True:
    i = 0  # indented by spaces
	j = 0  # indented by a tab
