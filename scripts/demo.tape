# VHS Demo Tape for AgentOS
# Records: help, agent roster, status
# Run: vhs agentos-demo.tape

Output agentos-demo.gif

Set Shell zsh
Set FontSize 14
Set Width 1100
Set Height 650
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set WindowBar Colorful
Set BorderRadius 8
Set WindowBarSize 40
Set CursorBlink false

# Show the CLI overview
Type "aos --help"
Enter
Sleep 4s

# Show the AI executive team
Type "aos agent list"
Enter
Sleep 4s

# Show what agents are currently working on
Type "aos status"
Enter
Sleep 4s

# Show usage examples (just typed, not executed)
Type 'echo "Start an agent:  aos spawn ENG-42"'
Enter
Sleep 1s
Type 'echo "Watch it work:   aos jump ENG-42"'
Enter
Sleep 2.5s
