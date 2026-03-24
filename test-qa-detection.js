/**
 * 问题-回答对维度识别测试
 * 专门测试基于AI提问和用户回答的精准识别
 */

const fs = require('fs');
const path = require('path');

// 模拟API调用
async function testQADetection() {
  console.log('🚀 开始测试问题-回答对维度识别优化效果\n');
  console.log('================================================================================\n');

  const testCases = [
    {
      name: '测试1: AI明确询问项目经历，用户具体回答',
      description: 'AI使用[ASKING:project]标记询问项目经历，用户提供具体项目信息',
      messages: [
        { role: 'assistant', content: '请介绍一下你的项目经历。[ASKING:project]' },
        { role: 'user', content: '我做过一个机器学习项目，使用TensorFlow实现图像分类，项目名称是"智能图像识别系统"，获得了学校创新奖。' },
        { role: 'assistant', content: '很好！还有其他项目经历吗？' },
        { role: 'user', content: '还有一个Web开发项目，用React和Node.js构建了一个在线学习平台。' }
      ],
      expected: ['project'],
      shouldPass: true
    },
    {
      name: '测试2: AI询问项目经历，用户模糊回答',
      description: 'AI询问项目经历，但用户回答模糊，不应该识别项目维度',
      messages: [
        { role: 'assistant', content: '有没有做过什么项目？[ASKING:project]' },
        { role: 'user', content: '做过一些项目，但没什么特别的。' }
      ],
      expected: [],
      shouldPass: true
    },
    {
      name: '测试3: AI询问实习经历，用户具体回答',
      description: 'AI询问实习经历，用户提供具体公司和工作内容',
      messages: [
        { role: 'assistant', content: '请介绍一下你的实习经历。[ASKING:internship]' },
        { role: 'user', content: '我在字节跳动实习过3个月，岗位是后端开发工程师，负责广告推荐系统的性能优化。' }
      ],
      expected: ['internship'],
      shouldPass: true
    },
    {
      name: '测试4: AI询问学术背景，用户提供具体GPA',
      description: 'AI询问学术背景，用户提供具体GPA和课程信息',
      messages: [
        { role: 'assistant', content: '请介绍一下你的学术背景。[ASKING:academic]' },
        { role: 'user', content: '我的GPA是3.8/4.0，专业排名前10%。学习了数据结构、算法、操作系统等核心课程。' }
      ],
      expected: ['academic'],
      shouldPass: true
    },
    {
      name: '测试5: 混合维度 - AI询问多个问题',
      description: 'AI询问多个维度，用户分别回答',
      messages: [
        { role: 'assistant', content: '请介绍一下你的科研经历。[ASKING:research]' },
        { role: 'user', content: '我在清华大学计算机视觉实验室做过科研，研究基于深度学习的图像分割。' },
        { role: 'assistant', content: '那你的未来规划是什么？[ASKING:plan]' },
        { role: 'user', content: '计划毕业后在AI公司工作，长期想从事机器学习研究。' }
      ],
      expected: ['research', 'plan'],
      shouldPass: true
    },
    {
      name: '测试6: 问题中没有标记，但内容相关',
      description: 'AI提问中没有[ASKING]标记，但内容明显相关',
      messages: [
        { role: 'assistant', content: '你为什么想申请计算机科学专业？' },
        { role: 'user', content: '因为对人工智能有浓厚兴趣，高中时就开始学习编程。' }
      ],
      expected: ['motivation'],
      shouldPass: true
    },
    {
      name: '测试7: 避免过度识别 - 提到"项目"但不是项目经历',
      description: '对话中提到"项目"一词，但不是项目经历维度',
      messages: [
        { role: 'assistant', content: '你在实习期间负责什么工作？' },
        { role: 'user', content: '我负责公司的一个重点项目，优化系统性能。' }
      ],
      expected: ['internship'], // 应该是实习维度，不是项目维度
      shouldPass: true
    },
    {
      name: '测试8: 申请动机维度识别',
      description: 'AI询问申请动机，用户具体回答',
      messages: [
        { role: 'assistant', content: '为什么选择申请我们学校？[ASKING:motivation]' },
        { role: 'user', content: '因为贵校在人工智能领域有很强的师资和研究实力，特别是李教授的机器学习实验室。' }
      ],
      expected: ['motivation'],
      shouldPass: true
    }
  ];

  let passed = 0;
  let failed = 0;

  for (const testCase of testCases) {
    console.log(`📋 ${testCase.name}`);
    console.log(`📝 ${testCase.description}`);
    
    // 模拟调用API
    const result = await simulateAPICall(testCase.messages);
    const detectedDimensions = result.coveredDimensions || [];
    
    console.log(`💬 对话示例: ${JSON.stringify(testCase.messages.map(m => m.content.substring(0, 50) + '...'))}`);
    
    // 检查结果
    const isCorrect = arraysEqual(detectedDimensions.sort(), testCase.expected.sort());
    
    if (isCorrect) {
      console.log(`✅ 通过: 正确识别维度 ${JSON.stringify(detectedDimensions)}`);
      passed++;
    } else {
      console.log(`❌ 失败:`);
      console.log(`   期望: ${JSON.stringify(testCase.expected)}`);
      console.log(`   实际: ${JSON.stringify(detectedDimensions)}`);
      
      // 找出差异
      const extra = detectedDimensions.filter(d => !testCase.expected.includes(d));
      const missing = testCase.expected.filter(d => !detectedDimensions.includes(d));
      
      if (extra.length > 0) {
        console.log(`   过度识别: ${JSON.stringify(extra)}`);
      }
      if (missing.length > 0) {
        console.log(`   识别遗漏: ${JSON.stringify(missing)}`);
      }
      
      failed++;
    }
    
    console.log('------------------------------------------------------------\n');
  }

  console.log('================================================================================');
  console.log('📊 测试总结');
  console.log(`✅ 通过: ${passed}/${testCases.length} (${Math.round(passed/testCases.length*100)}%)`);
  console.log(`❌ 失败: ${failed}/${testCases.length}`);
  
  if (failed > 0) {
    console.log('\n💡 优化建议:');
    console.log('1. 检查问题-回答对分析函数的匹配逻辑');
    console.log('2. 验证回答质量评估标准是否合理');
    console.log('3. 确保问题模式映射准确');
    console.log('4. 测试边界情况和模糊回答的处理');
  }
}

// 模拟API调用
async function simulateAPICall(messages) {
  // 这里我们模拟API调用的逻辑
  // 在实际测试中，应该调用真实的API端点
  
  // 构建请求体
  const requestBody = {
    messages,
    alreadyCovered: []
  };
  
  try {
    // 尝试调用本地API
    const response = await fetch('http://localhost:3000/api/detect-dimensions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      throw new Error(`API调用失败: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.log(`⚠️  API调用失败: ${error.message}`);
    console.log('   使用模拟结果进行测试...');
    
    // 返回模拟结果用于测试
    return simulateDetectionLogic(messages);
  }
}

// 模拟检测逻辑（当API不可用时使用）
function simulateDetectionLogic(messages) {
  // 简化的模拟逻辑
  const detected = [];
  const conversationText = messages.map(m => m.content).join(' ');
  
  // 检查每个维度
  const dimensions = [
    { key: 'academic', patterns: ['gpa', '成绩', '课程', '专业'] },
    { key: 'research', patterns: ['科研', '研究', '论文', '实验室'] },
    { key: 'internship', patterns: ['实习', '公司', '工作', '岗位'] },
    { key: 'project', patterns: ['项目', '开发', '实现', '技术'] },
    { key: 'motivation', patterns: ['为什么', '申请', '选择', '兴趣'] },
    { key: 'plan', patterns: ['规划', '计划', '未来', '目标'] },
    { key: 'personal', patterns: ['个人', '成长', '挑战', '性格'] }
  ];
  
  for (const dim of dimensions) {
    // 检查是否有相关问题-回答对
    let hasRelevantQA = false;
    
    // 查找问题-回答对
    for (let i = 0; i < messages.length - 1; i++) {
      if (messages[i].role === 'assistant' && messages[i + 1].role === 'user') {
        const question = messages[i].content.toLowerCase();
        const answer = messages[i + 1].content.toLowerCase();
        
        // 检查问题是否相关
        let isRelevant = false;
        for (const pattern of dim.patterns) {
          if (question.includes(pattern)) {
            isRelevant = true;
            break;
          }
        }
        
        // 检查[ASKING]标记
        if (question.includes(`[asking:${dim.key}]`)) {
          isRelevant = true;
        }
        
        if (isRelevant) {
          // 检查回答质量
          const answerLength = answer.length;
          const hasDetails = answer.includes('具体') || answer.includes('例如') || answer.includes('比如');
          const hasNumbers = /\d+/.test(answer);
          
          if (answerLength > 50 && (hasDetails || hasNumbers)) {
            hasRelevantQA = true;
            break;
          }
        }
      }
    }
    
    if (hasRelevantQA) {
      detected.push(dim.key);
    }
  }
  
  return {
    dimensions: detected.map(key => ({ key, covered: true })),
    coveredDimensions: detected,
    analysisSummary: {
      totalMessages: messages.length,
      coveredCount: detected.length
    },
    success: true
  };
}

// 辅助函数：比较数组是否相等
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((val, index) => val === sortedB[index]);
}

// 运行测试
testQADetection().catch(console.error);