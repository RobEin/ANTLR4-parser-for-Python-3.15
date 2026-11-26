# COMMAND LINE:
# grun Python file_input -tokens test_tab_and_space_in_indentation.py
#
# EXPECTATIONS:
#   - no error

if True:
	 	i = 0  # indented by: <tab><space><tab>
 		j = 0  # indented by: <space><tab><tab>
