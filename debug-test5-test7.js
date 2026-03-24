/**
 * 调试测试5和测试7
 */

// 测试5: 混合维度 - AI询问多个问题
console.log('================================================================================');
console.log('🧪 测试5: 混合维度 - AI询问多个问题');
console.log('================================================================================');

const testCase5 = [
  { role: 'assistant', content: '请介绍一下你的科研经历。[ASKING:research]' },
  { role: 'user', content: '我在清华大学计算机视觉实验室做过科研，研究基于深度学习的图像分割。' },
  { role: 'assistant', content: '那你的未来规划是什么？[ASKING:plan]' },
  { role: 'user', content: '计划毕业后在AI公司工作，长期想从事机器学习研究。' }
];

console.log('对话内容:');
testCase5.forEach((msg, i) => {
  console.log(`  ${msg.role}: ${msg.content}`);
});

console.log('\n分析:');
console.log('1. 第一个问题: "请介绍一下你的科研经历。[ASKING:research]"');
console.log('   - 包含标记 [ASKING:research]');
console.log('   - 应该匹配 research 维度');

console.log('\n2. 第二个问题: "那你的未来规划是什么？[ASKING:plan]"');
console.log('   - 包含标记 [ASKING:plan]');
console.log('   - 应该匹配 plan 维度');
console.log('   - 用户回答: "计划毕业后在AI公司工作，长期想从事机器学习研究。"');
console.log('   - 回答长度: 28字符');
console.log('   - 包含关键词: "计划", "毕业后", "工作", "研究"');

// 测试7: 避免过度识别 - 提到"项目"但不是项目经历
console.log('\n\n================================================================================');
console.log('🧪 测试7: 避免过度识别 - 提到"项目"但不是项目经历');
console.log('================================================================================');

const testCase7 = [
  { role: 'assistant', content: '你在实习期间负责什么工作？' },
  { role: 'user', content: '我负责公司的一个重点项目，优化系统性能。' }
];

console.log('对话内容:');
testCase7.forEach((msg, i) => {
  console.log(`  ${msg.role}: ${msg.content}`);
});

console.log('\n分析:');
console.log('1. AI问题: "你在实习期间负责什么工作？"');
console.log('   - 包含关键词: "实习", "期间", "负责", "工作"');
console.log('   - 应该匹配 internship 维度的问题模式');

console.log('\n2. 用户回答: "我负责公司的一个重点项目，优化系统性能。"');
console.log('   - 回答长度: 20字符');
console.log('   - 包含关键词: "负责", "公司", "项目", "优化", "系统", "性能"');
console.log('   - 包含"项目"一词，但这是在实习背景下提到的');

console.log('\n💡 问题分析:');
console.log('1. 测试5中plan维度可能因为:');
console.log('   - 回答长度较短(28字符)，得分可能不够');
console.log('   - 或者plan维度的匹配模式有问题');

console.log('\n2. 测试7中internship维度可能因为:');
console.log('   - 回答长度较短(20字符)，得分可能不够');
console.log('   - 没有[ASKING]标记，需要bestScore >= 5才能覆盖');
console.log('   - 但实际得分只有3分');

console.log('\n🔧 建议解决方案:');
console.log('1. 对于有明确维度标记的问题，降低覆盖阈值');
console.log('2. 增加plan维度的特定检查，如包含"计划"、"目标"等关键词时加分');
console.log('3. 对于internship维度，当问题明确提到"实习"时，即使回答较短也应识别');