-- 红线/偏好规则来源溯源：记录 AI 提炼所来源的企业范本标题（导入时落库，编辑不覆盖）
ALTER TABLE "playbook_rules" ADD COLUMN "source_label" VARCHAR(200);
