-- 控制中心已经打开之后，点声音里的 AirPlay，再点同名音箱。不改音量。
-- 调用：osascript select-output.applescript <deviceName>
-- deviceName 为 --dump 时只打印候选，不点任何音箱。
use scripting additions

on run argv
	if (count of argv) < 1 then error "missing arguments"
	set deviceName to item 1 of argv
	try
		tell application "System Events"
			tell process "ControlCenter"
				set appeared to false
				repeat 16 times
					if exists window "控制中心" then
						set appeared to true
						exit repeat
					end if
					delay 0.12
				end repeat
				if appeared is false then error "控制中心没有打开"
				tell window "控制中心"
					tell group 1
						set airPlayBox to missing value
						repeat with entry in UI elements
							try
								if (value of attribute "AXIdentifier" of entry as text) is "module-Sound" then
									repeat with child in UI elements of entry
										try
											if (value of attribute "AXIdentifier" of child as text) is "controlcenter-airplay" then set airPlayBox to child
										end try
									end repeat
								end if
							end try
						end repeat
						if airPlayBox is missing value then error "声音面板里没有 AirPlay"
						click airPlayBox
					end tell
				end tell
				delay 0.7
				set matched to missing value
				set dumped to ""
				repeat 8 times
					set dumped to ""
					repeat with host in windows
						try
							set entries to entire contents of host
							repeat with entry in entries
								try
									if role of entry is "AXCheckBox" then
										set ident to ""
										set labelText to ""
										set entryValue to ""
										try
											set ident to value of attribute "AXIdentifier" of entry as text
										end try
										try
											set labelText to description of entry as text
										end try
										try
											set entryValue to value of entry as text
										end try
										if ident is not "controlcenter-airplay" and ident does not start with "module-" then
											set dumped to dumped & ident & tab & labelText & tab & entryValue & linefeed
											set shortName to ident
											if shortName starts with "sound-device-" then set shortName to text 14 thru -1 of shortName
											if deviceName is not "--dump" and (shortName is deviceName or labelText is deviceName) then set matched to entry
										end if
									end if
								end try
							end repeat
						end try
					end repeat
					if deviceName is "--dump" or matched is not missing value then exit repeat
					delay 0.25
				end repeat
				if deviceName is "--dump" then
					my closePanel()
					return dumped
				end if
				if matched is missing value then error "列表里没有「" & deviceName & "」"
				try
					if (value of matched as integer) is 1 then
						my closePanel()
						return "already"
					end if
				end try
				click matched
				delay 0.2
			end tell
		end tell
		my closePanel()
		return "ok"
	on error message
		my closePanel()
		error message
	end try
end run

on closePanel()
	try
		tell application "System Events" to key code 53
		delay 0.08
		tell application "System Events" to key code 53
	end try
end closePanel
