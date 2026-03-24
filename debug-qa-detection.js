/**
 * 调试问题-回答对维度识别
 */

// 模拟 analyzeByQA 函数的简化版本
function debugAnalyzeByQA(messages) {
  const DIMENSIONS = [
    { key: 'academic', label: '学术背景' },
    { key: 'research', label: '科研经历' },
    { key: 'internship', label: '实习经历' },
    { key: 'project', label: '项目经历' },
    { key: 'motivation', label: '申请动机' },
    { key: 'plan', label: '未来规划' },
    { key: 'personal', label: '个人特质' }
  ];

  // 问题模式与维度映射
  const questionPatterns = {
    academic: ['本科.*学校|专业', 'gpa|成绩|绩点|排名', '课程|专业课|科目', '毕业论文|毕设|论文', '学术表现|学习情况', '奖学金|荣誉'],
    research: ['科研|研究|实验室', '论文|发表|期刊|会议', '导师|教授|课题组', '实验|数据|分析', '研究课题|科研项目'],
    internship: ['实习|工作|公司', '岗位|职位|职责', '企业|职场|就业', '暑期|寒假|兼职', '工作内容|任务', '实习经历'],
    project: ['项目|project', '开发|技术|实现', '课程.*项目|作业', '个人.*项目|作品', '竞赛|比赛|挑战', '项目经历'],
    motivation: ['为什么.*申请|选择', '动机|原因|兴趣', '为什么.*这个.*专业|方向', '为什么.*这个.*学校|国家', '申请原因'],
    plan: ['未来.*规划|计划', '毕业后.*想.*做', '职业.*目标|方向', '短期|长期.*计划', '想.*从事|成为', '职业规划'],
    personal: ['个人.*成长|经历', '挑战|困难|克服', '性格|特质|特点', '故事|经历|事件', '价值观|信念', '个人特质']
  };

  // 提取问题-回答对
  const qaPairs = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const current = messages[i];
    const next = messages[i + 1];
    
    if (current.role === 'assistant' && next.role === 'user') {
      qaPairs.push({
        question: current.content,
        answer: next.content,
        questionIndex: i,
        answerIndex: i + 1
      });
    }
  }

  console.log('🔍 调试分析开始');
  console.log(`找到 ${qaPairs.length} 个问题-回答对`);
  
  const results = {};
  
  for (const dim of DIMENSIONS) {
    results[dim.key] = {
      label: dim.label,
      qaCount: 0,
      bestScore: 0,
      evidence: '',
      covered: false
    };
    
    const patterns = questionPatterns[dim.key] || [];
    
    for (const qa of qaPairs) {
      const question = qa.question.toLowerCase();
      const answer = qa.answer.toLowerCase();
      
      // 检查问题是否属于当前维度
      let isRelevant = false;
      for (const pattern of patterns) {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(question)) {
          isRelevant = true;
          console.log(`  ${dim.key}: 问题匹配模式 "${pattern}"`);
          break;
        }
      }
      
      // 检查[ASKING]标记
      if (question.includes(`[asking:${dim.key}]`)) {
        isRelevant = true;
        console.log(`  ${dim.key}: 问题包含标记 [asking:${dim.key}]`);
      }
      
      if (isRelevant) {
        results[dim.key].qaCount++;
        
        // 评估回答质量
        let score = 0;
        
        // 回答长度
        if (qa.answer.length > 100) score += 3;
        else if (qa.answer.length > 50) score += 2;
        else if (qa.answer.length > 20) score += 1;
        
        console.log(`  ${dim.key}: 回答长度 ${qa.answer.length} 字符，得分 +${score}`);
        
        // 维度特定检查
        if (dim.key === 'internship' && (/公司[:：]?\s*\S+/.test(answer) || /实习.*期间|期间.*负责|负责.*工作/.test(answer))) {
          score += 3;
          console.log(`  ${dim.key}: 实习相关匹配，得分 +3`);
        }
        
        if (dim.key === 'personal') {
          const hasPersonalKeywords = /个人成长|挑战.*克服|困难.*经历|性格.*特质/.test(answer);
          const hasStory = /故事|经历|事件/.test(answer);
          if (hasPersonalKeywords && hasStory) {
            score += 3;
            console.log(`  ${dim.key}: 个人特质匹配，得分 +3`);
          }
        }
        
        if (score > results[dim.key].bestScore) {
          results[dim.key].bestScore = score;
          results[dim.key].evidence = `问题: "${qa.question.substring(0, 50)}..."`;
        }
        
        // 判断是否覆盖
        if (score >= 5) {
          results[dim.key].covered = true;
        }
      }
    }
    
    console.log(`📊 ${dim.key} (${dim.label}): qaCount=${results[dim.key].qaCount}, bestScore=${results[dim.key].bestScore}, covered=${results[dim.key].covered}`);
  }
  
  return results;
}

// 测试用例1: AI明确询问项目经历，用户具体回答
console.log('================================================================================');
console.log('🧪 测试用例1: AI明确询问项目经历，用户具体回答');
console.log('================================================================================');

const testCase1 = [
  { role: 'assistant', content: '请介绍一下你的项目经历。[ASKING:project]' },
  { role: 'user', content: '我做过一个机器学习项目，使用TensorFlow实现图像分类，项目名称是"智能图像识别系统"，获得了学校创新奖。' },
  { role: 'assistant', content: '很好！还有其他项目经历吗？' },
  { role: 'user', content: '还有一个Web开发项目，用React和Node.js构建了一个在线学习平台。' }
];

const results1 = debugAnalyzeByQA(testCase1);

console.log('\n📋 测试用例1总结:');
const covered1 = Object.keys(results1).filter(key => results1[key].covered);
console.log(`覆盖的维度: ${covered1.length > 0 ? covered1.join(', ') : '无'}`);

// 测试用例7: 避免过度识别 - 提到"项目"但不是项目经历
console.log('\n\n================================================================================');
console.log('🧪 测试用例7: 避免过度识别 - 提到"项目"但不是项目经历');
console.log('================================================================================');

const testCase7 = [
  { role: 'assistant', content: '你在实习期间负责什么工作？' },
  { role: 'user', content: '我负责公司的一个重点项目，优化系统性能。' }
];

const results7 = debugAnalyzeByQA(testCase7);

console.log('\n📋 测试用例7总结:');
const covered7 = Object.keys(results7).filter(key => results7[key].covered);
console.log(`覆盖的维度: ${covered7.length > 0 ? covered7.join(', ') : '无'}`);

// 分析问题
console.log('\n\n🔍 问题分析:');
console.log('1. 测试用例1中personal维度被识别:');
console.log('   - 用户回答包含"获得了学校创新奖"');
console.log('   - 这可能触发了personal维度的匹配');
console.log('   - 需要检查personal维度的匹配模式是否过于宽松');

console.log('\n2. 测试用例7中internship维度未被识别:');
console.log('   - AI问题:"你在实习期间负责什么工作？"');
console.log('   - 应该匹配internship维度的问题模式');
console.log('   - 用户回答:"我负责公司的一个重点项目，优化系统性能。"');
console.log('   - 回答长度较短，可能未达到分数阈值');