把下面的简历文本解析成 JSON 资料，结构如下（没有的字段省略，不要编造；日期用 YYYY-MM 或 YYYY-MM-DD）：
{
 "basics": {"name","nameEn","gender","birthDate","phone","email","wechat","idNumber","nationality","ethnicity","politicalStatus","maritalStatus","hometown","hukou","currentCity","address", ...任何其他基本信息},
 "education": [{"school","degree","studyMode","major","college","start","end","gpa","rank","courses","thesis", ...}],
 "experience": [{"company","title","department","city","start","end","description", ...}],
 "projects": [{"name","role","start","end","description","tech": []}],
 "awards": [{"name","level","rank","date","description"}],
 "campus": [{"org","role","start","end","description"}],
 "skills": ["..."],
 "languages": [{"name","level","score"}],
 "certificates": [{"name","date","score"}],
 "jobPreference": {"cities": [], "positions": [], "salary", "availableFrom"},
 "links": {"github","blog","linkedin","portfolio"},
 "freeText": {"selfIntro","strengths","careerPlan"}
}
教育经历按时间倒序（最高学历在前）。竞赛/比赛（无论获奖名次）、奖学金、荣誉称号都放进 awards（rank 写名次，如"全国三等奖"）；campus 只放担任过的学生职务、社团职务。只输出 JSON。